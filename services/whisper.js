/**
 * Whisper AI transcription service — versión mejorada.
 *
 * Mejoras anti-alucinación:
 * - temperature=0 → resultado determinista, sin inventar texto
 * - Filtro de no_speech_prob: descarta segmentos sin voz real
 * - Filtro de texto repetitivo: elimina loops que Whisper genera en silencio
 * - Deduplicación: elimina subtítulos idénticos consecutivos
 * - Detección de segmentos muy cortos/vacíos
 * - Prompt contextual para mejorar accuracy
 */

const ffmpeg = require('fluent-ffmpeg');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const logger = require('./logger').child({ module: 'whisper' });

const WHISPER_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

// ─── Umbrales anti-alucinación ────────────────────────────────
// Whisper devuelve no_speech_prob: probabilidad de que el segmento NO sea voz.
// Valores > 0.4 suelen ser silencio/ruido/música → descartar.
// Bajamos el umbral de 0.6 a 0.4 para eliminar alucinaciones sobre música.
const NO_SPEECH_THRESHOLD = 0.4;

// avg_logprob: confianza del segmento. Valores < -1.0 indican baja confianza.
// Valores muy negativos (< -0.8) suelen ser música o ruido transcrito.
const LOW_CONFIDENCE_THRESHOLD = -0.8;

// Longitud mínima de texto para considerar válido un segmento
const MIN_TEXT_LENGTH = 3;

// Duración mínima de un segmento en segundos (evita glitches)
const MIN_SEGMENT_DURATION = 0.5;

// ─── Audio extraction ─────────────────────────────────────────

function extractAudio(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();

    if (videoPath.endsWith('concat-list.txt')) {
      cmd.input(videoPath).inputOptions(['-f', 'concat', '-safe', '0']);
    } else if (videoPath.endsWith('.m3u8')) {
      cmd.input(videoPath).inputOptions([
        '-protocol_whitelist', 'file,crypto,data',
        '-allowed_extensions', 'ALL',
      ]);
    } else {
      cmd.input(videoPath);
    }

    cmd.audioChannels(1)
       .audioFrequency(16000)
       .audioCodec('libmp3lame')
       .noVideo()
       .addOptions([
         '-q:a', '3',               // calidad VBR ligeramente mayor
         '-avoid_negative_ts', 'make_zero',
       ])
       .output(outputPath)
       .on('end', resolve)
       .on('error', reject)
       .run();
  });
}

// ─── VTT helpers ─────────────────────────────────────────────

function parseVttWordCount(vtt) {
  return (vtt.match(/[a-záéíóúüñA-ZÁÉÍÓÚÜÑ\w]+/g) || []).length;
}

function parseVttDuration(vtt) {
  const matches = [...vtt.matchAll(/(\d{2}:\d{2}:\d{2}\.\d{3}) -->/g)];
  if (!matches.length) return 0;
  const last = matches[matches.length - 1][1];
  const [h, m, s] = last.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

function formatVttTimestamp(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${s.toFixed(3).padStart(6,'0')}`;
}

// ─── Filtros anti-alucinación ─────────────────────────────────

/**
 * Detecta texto alucinado: patrones que Whisper repite en loops
 * cuando no hay voz (música de fondo, silencio, etc.)
 */
const HALLUCINATION_PATTERNS = [
  /^\s*$/,                                          // vacío
  /^\.{3,}$/,                                       // solo puntos
  /^[\s\.\,\!\?\-]+$/,                              // solo puntuación
  /subtítulos?\s*(realizados?|por|para)/i,           // meta-texto de subtitulado
  /sous-titres?\s*(réalisés?|par|pour)/i,
  /subtitles?\s*(by|for|made)/i,
  /amara\.org/i,                                    // marca de agua Amara
  /www\.[a-z0-9\-]+\.[a-z]{2,}/i,                  // URLs
  /suscríbete|subscribe|abonnez-vous/i,             // call-to-action spam
  /síguenos|follow us/i,
  /gracias por ver/i,
  /thank you for watching/i,
  /\[música\]|\[music\]|\[applause\]|\[aplausos\]/i, // etiquetas de audio
  /\[silencio\]|\[silence\]/i,
  /\[traducción\]|\[translation\]/i,
];

function isHallucinated(text) {
  if (!text || text.trim().length < MIN_TEXT_LENGTH) return true;
  return HALLUCINATION_PATTERNS.some(p => p.test(text));
}

/**
 * Elimina segmentos repetitivos consecutivos (otro patrón de alucinación).
 * Whisper a veces repite el mismo texto 5-10 veces seguidas.
 */
function deduplicateSegments(segments) {
  const result = [];
  const windowSize = 5; // comparar con los últimos N segmentos

  for (const seg of segments) {
    const normalizedText = seg.text.trim().toLowerCase().replace(/\s+/g, ' ');
    const recentTexts = result.slice(-windowSize).map(s =>
      s.text.trim().toLowerCase().replace(/\s+/g, ' ')
    );

    // Saltar si el texto exacto ya aparece en los últimos N segmentos
    if (recentTexts.includes(normalizedText)) continue;

    // Saltar si el texto es muy similar (>80% overlap) con el segmento anterior
    if (result.length > 0) {
      const prev = result[result.length - 1].text.trim().toLowerCase();
      const curr = normalizedText;
      if (prev.length > 10 && curr.length > 10) {
        // Similitud simple: uno contiene al otro
        if (prev.includes(curr) || curr.includes(prev)) continue;
      }
    }

    result.push(seg);
  }

  return result;
}

// ─── Conversión JSON → VTT ────────────────────────────────────

function convertJsonToVtt(whisperJson, videoDuration) {
  if (!whisperJson.segments || whisperJson.segments.length === 0) {
    return 'WEBVTT\n\n';
  }

  // 1. Filtrar segmentos con alta probabilidad de no-voz
  let segments = whisperJson.segments.filter(seg => {
    const noSpeechProb = seg.no_speech_prob ?? 0;
    if (noSpeechProb > NO_SPEECH_THRESHOLD) {
      logger.debug({ noSpeechProb: noSpeechProb.toFixed(2), text: seg.text?.trim() }, 'whisper: discarding silent segment');
      return false;
    }
    return true;
  });

  // 2. Filtrar texto alucinado
  segments = segments.filter(seg => {
    const text = (seg.text || '').trim();
    if (isHallucinated(text)) {
      logger.debug({ text }, 'whisper: discarding hallucinated text');
      return false;
    }
    return true;
  });

  // 3. Filtrar segmentos muy cortos
  segments = segments.filter(seg => {
    const duration = (seg.end || 0) - (seg.start || 0);
    return duration >= MIN_SEGMENT_DURATION;
  });

  // 4. Deduplicar repeticiones
  segments = deduplicateSegments(segments);

  // 5. Detectar y corregir offset de silencio inicial
  // Si el primer segmento empieza en 0 pero hay un gap significativo
  // entre el inicio y cuando realmente hay actividad de audio, Whisper
  // puede asignar el timestamp 0 incorrectamente.
  // Usamos el avg_logprob para detectar segmentos de baja confianza al inicio.
  if (segments.length > 0) {
    const first = segments[0];
    // Si el primer segmento tiene avg_logprob muy bajo (< -1.0), es probablemente ruido
    if (first.avg_logprob !== undefined && first.avg_logprob < -1.0 && first.start === 0) {
      logger.debug({ avg_logprob: first.avg_logprob.toFixed(2) }, 'whisper: dropping low-confidence first segment');
      segments = segments.slice(1); // descartar primer segmento poco fiable
    }
  }

  // 5. Normalizar y generar VTT
  let vtt = 'WEBVTT\n\n';
  let cueIndex = 1;

  for (const seg of segments) {
    let start = Math.max(0, seg.start || 0);
    let end   = seg.end || (start + 2);

    if (videoDuration) {
      start = Math.min(start, videoDuration);
      end   = Math.min(end, videoDuration);
    }

    if (end <= start) end = start + 1;

    const text = (seg.text || '').trim();

    vtt += `${cueIndex}\n`;
    vtt += `${formatVttTimestamp(start)} --> ${formatVttTimestamp(end)}\n`;
    vtt += `${text}\n\n`;
    cueIndex++;
  }

  return vtt;
}

// ─── Whisper API call ─────────────────────────────────────────

const WHISPER_MAX_RETRIES = 5;
const WHISPER_BASE_DELAY  = 10_000; // 10 s base antes del primer retry

async function transcribeFile(audioPath, language = 'es', options = {}) {
  const apiKey = options.openaiApiKey;
  if (!apiKey) throw new Error('OpenAI API Key is not configured for this workspace');

  const audioBuffer = fs.readFileSync(audioPath);

  const prompt = options.prompt ? options.prompt.slice(0, 224) : '';

  let lastError;
  for (let attempt = 0; attempt <= WHISPER_MAX_RETRIES; attempt++) {
    // Rebuild FormData on each attempt (fetch consumes the body)
    const audioBlob = new Blob([audioBuffer], { type: 'audio/mpeg' });
    const form = new FormData();
    form.append('file',            audioBlob, 'audio.mp3');
    form.append('model',           'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('language',        language);
    form.append('timestamp_granularities[]', 'segment');
    form.append('temperature', '0');
    if (prompt) form.append('prompt', prompt);

    const res = await fetch(WHISPER_ENDPOINT, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body:    form,
    });

    if (res.ok) {
      const jsonResult = await res.json();
      return convertJsonToVtt(jsonResult, options.videoDuration);
    }

    const errText = await res.text();

    // Rate limit — back off and retry
    if (res.status === 429 && attempt < WHISPER_MAX_RETRIES) {
      // Respect Retry-After header when present (value is in seconds)
      const retryAfterSec = parseInt(res.headers.get('retry-after') || '0', 10);
      const delaySec = retryAfterSec > 0
        ? retryAfterSec
        : Math.round((WHISPER_BASE_DELAY * Math.pow(2, attempt) + Math.random() * 2000) / 1000);
      logger.warn({ attempt: attempt + 1, maxRetries: WHISPER_MAX_RETRIES, delaySec }, 'whisper: 429 rate limit, retrying');
      await new Promise(r => setTimeout(r, delaySec * 1000));
      lastError = new Error(`Whisper API error 429: ${errText}`);
      continue;
    }

    throw new Error(`Whisper API error ${res.status}: ${errText}`);
  }

  throw lastError;
}

// ─── Get video metadata ───────────────────────────────────────

function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format?.duration || 0);
    });
  });
}

// ─── Main pipeline ────────────────────────────────────────────

async function transcribeVideo(videoPath, language = 'es', options = {}) {
  const tmpAudio = path.join(os.tmpdir(), `sv-audio-${Date.now()}.mp3`);

  try {
    let videoDuration = options.videoDuration;
    if (!videoDuration) {
      try {
        videoDuration = await getVideoDuration(videoPath);
        logger.debug({ durationSecs: videoDuration.toFixed(2) }, 'whisper: video duration');
      } catch {
        logger.warn('whisper: could not get video duration');
      }
    }

    await extractAudio(videoPath, tmpAudio);

    const vttContent = await transcribeFile(tmpAudio, language, {
      videoDuration,
      prompt: options.prompt || options.title || '',
    });

    const wordCount    = parseVttWordCount(vttContent);
    const durationSecs = parseVttDuration(vttContent);

    logger.info({ wordCount, durationSecs: durationSecs.toFixed(2) }, 'whisper: transcription complete');

    return { vttContent, wordCount, durationSecs };
  } finally {
    try { fs.unlinkSync(tmpAudio); } catch {}
  }
}

module.exports = { transcribeVideo, extractAudio, getVideoDuration };
