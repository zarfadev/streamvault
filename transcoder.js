const ffmpeg  = require('fluent-ffmpeg');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const os      = require('os');
const db      = require('./db');
const config  = require('./config');
const s3      = require('./services/s3Storage');
const { getJsonConfig } = s3;
const { sendTranscodeComplete, sendTranscodeError } = require('./services/email');
const logger  = require('./services/logger').child({ module: 'transcoder' });

// ── Active FFmpeg process registry ───────────────────────────────────────────
// Tracks all running FFmpeg child processes so they can be killed cleanly
// during graceful shutdown, preventing zombie processes that consume CPU.
const _activeProcesses = new Set();

/**
 * Register a fluent-ffmpeg command so it can be killed on shutdown.
 * @param {object} cmd — fluent-ffmpeg command instance
 * @returns {object} the same cmd (for chaining)
 */
function trackProcess(cmd) {
  _activeProcesses.add(cmd);
  return cmd;
}

function untrackProcess(cmd) {
  _activeProcesses.delete(cmd);
}

/**
 * Kill all active FFmpeg processes gracefully.
 * Called by the graceful shutdown handler in server.js and worker.js.
 */
function killAllFFmpeg() {
  if (_activeProcesses.size === 0) return;
  logger.warn(`[transcoder] Killing ${_activeProcesses.size} active FFmpeg process(es)…`);
  for (const cmd of _activeProcesses) {
    try { cmd.kill('SIGTERM'); } catch {}
  }
  _activeProcesses.clear();
}

const QUALITY_PRESETS = [
  { name: '360p',  height: 360,  vbr: '700k',   abr: '96k',  profile: 'baseline' },
  { name: '480p',  height: 480,  vbr: '1200k',  abr: '128k', profile: 'main'     },
  { name: '720p',  height: 720,  vbr: '2500k',  abr: '128k', profile: 'main'     },
  { name: '1080p', height: 1080, vbr: '4500k',  abr: '192k', profile: 'high'     },
  { name: '1440p', height: 1440, vbr: '8000k',  abr: '256k', profile: 'high'     },
  { name: '4k',    height: 2160, vbr: '16000k', abr: '320k', profile: 'high'     },
];

// Parse bitrate safely: '700k' → 700, '1.2m' → 1200, plain numbers also accepted
function parseBitrateKbps(vbrStr) {
  const s = String(vbrStr || '0').trim().toLowerCase();
  const num = parseFloat(s);
  if (isNaN(num)) return 0;
  if (s.endsWith('m')) return Math.round(num * 1000);
  if (s.endsWith('g')) return Math.round(num * 1000000);
  // ends with 'k' or no suffix — value is already in kbps
  return Math.round(num);
}

function probeVideo(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(err);
      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
      // Parse frame rate fraction (e.g. "30/1", "24000/1001") → decimal
      let fps = 30;
      if (videoStream?.r_frame_rate) {
        const parts = videoStream.r_frame_rate.split('/');
        const num = parseFloat(parts[0] || '30');
        const den = parseFloat(parts[1] || '1');
        if (den > 0) fps = Math.round(num / den);
      }
      resolve({
        width: videoStream?.width || 0,
        height: videoStream?.height || 0,
        duration: metadata.format?.duration || 0,
        size: metadata.format?.size || 0,
        fps,
        videoCodec: videoStream?.codec_name,
        audioCodec: audioStream?.codec_name,
      });
    });
  });
}

function transcodeQuality(inputPath, outputDir, preset, videoInfo, keyInfoPath, onFrameProgress, threadsPerJob = 0) {
  return new Promise((resolve, reject) => {
    const segmentDir = path.join(outputDir, preset.name);
    fs.mkdirSync(segmentDir, { recursive: true });

    const m3u8Path = path.join(segmentDir, 'index.m3u8');
    const segmentPattern = path.join(segmentDir, 'seg%03d.ts');
    const targetHeight = Math.min(preset.height, videoInfo.height);
    const totalSecs = videoInfo.duration || 0;

    const HLS_TIME  = 4;
    const sourceFps = videoInfo.fps || 30;
    // Align GOP to segment boundaries so every segment starts with a keyframe.
    // sc_threshold 0 disables mid-segment forced keyframes on scene changes —
    // critical for anime which has hundreds of cuts per minute.
    const gopSize  = Math.max(1, Math.round(sourceFps * HLS_TIME));
    const vbrKbps = parseBitrateKbps(preset.vbr);

    const opts = [
      `-vf scale=-2:${targetHeight}:flags=fast_bilinear`,
      `-b:v ${preset.vbr}`,
      `-maxrate ${Math.round(vbrKbps * 1.5)}k`,
      `-bufsize ${Math.round(vbrKbps * 2)}k`,
      `-b:a ${preset.abr}`,
      `-ac 2`,
      `-ar 48000`,
      `-pix_fmt yuv420p`,
      `-profile:v ${preset.profile}`,
      `-preset ultrafast`,
      `-tune fastdecode`,
      `-sc_threshold 0`,
      `-g ${gopSize}`,
      `-keyint_min ${Math.max(1, Math.round(sourceFps / 2))}`,
      `-bf 0`,
      `-threads ${threadsPerJob}`,
      `-hls_time ${HLS_TIME}`,
      `-hls_playlist_type vod`,
      `-hls_segment_filename ${segmentPattern}`,
      `-hls_flags independent_segments`,
      `-f hls`,
    ];

    if (keyInfoPath) opts.push(`-hls_key_info_file ${keyInfoPath}`);

    const cmd = ffmpeg(inputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .addOptions(opts)
      .output(m3u8Path)
      .on('progress', prog => {
        if (onFrameProgress && totalSecs > 0 && prog.timemark) {
          const parts = prog.timemark.split(':').map(Number);
          const secs = (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
          onFrameProgress(Math.min(1, secs / totalSecs));
        }
      })
      .on('end', () => { untrackProcess(cmd); resolve(preset.name); })
      .on('error', (err) => { untrackProcess(cmd); reject(err); });

    trackProcess(cmd);
    cmd.run();
  });
}

/**
 * transcodeMultiQuality — single FFmpeg pass, multiple HLS outputs.
 *
 * Reads the source file ONCE and encodes all requested quality presets
 * simultaneously via filter_complex + split. This is 2-4× faster than
 * running separate FFmpeg processes because:
 *   • Heavy disk I/O (reading a 4–10 GB source) happens only once.
 *   • The decode step is shared across all outputs.
 *   • Total wall-clock time ≈ time to encode the SLOWEST (highest) quality,
 *     not the SUM of all qualities.
 *
 * @param {string}   inputPath   — local source file
 * @param {string}   outputDir   — base videos/{videoId}/ directory
 * @param {object[]} presets     — array of QUALITY_PRESETS entries (2+ for any benefit)
 * @param {object}   videoInfo   — probeVideo() result
 * @param {string}   keyInfoPath — HLS AES-128 keyinfo file path (or null)
 * @param {function} onProgress  — (fraction 0-1) progress callback
 * @returns {Promise<string[]>}  — names of qualities that completed ('360p', '480p', …)
 */
function transcodeMultiQuality(inputPath, outputDir, presets, videoInfo, keyInfoPath, onProgress) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const sourceFps  = videoInfo.fps    || 30;
    const totalSecs  = videoInfo.duration || 0;
    const HLS_TIME   = 4;
    const gopSize    = Math.max(1, Math.round(sourceFps * HLS_TIME));
    const keyintMin  = Math.max(1, Math.round(sourceFps / 2));
    const N          = presets.length;

    // ── filter_complex: split video stream N ways, scale each branch ─────────
    const splitLabels  = presets.map((_, i) => `[v${i}raw]`).join('');
    const splitFilter  = `[0:v]split=${N}${splitLabels}`;
    const scaleFilters = presets.map((p, i) => {
      const targetH = Math.min(p.height, videoInfo.height);
      return `[v${i}raw]scale=-2:${targetH}:flags=fast_bilinear[v${i}out]`;
    });
    const filterComplex = [splitFilter, ...scaleFilters].join(';');

    // ── Base FFmpeg args ──────────────────────────────────────────────────────
    const args = [
      '-hide_banner',
      '-loglevel', 'warning',   // warnings + progress to stderr
      '-stats',                  // show time= progress lines
      '-i', inputPath,
      '-filter_complex', filterComplex,
    ];

    // ── Per-output section ────────────────────────────────────────────────────
    for (let i = 0; i < presets.length; i++) {
      const p      = presets[i];
      const vbrKbps = parseBitrateKbps(p.vbr);
      const segDir  = path.join(outputDir, p.name);
      fs.mkdirSync(segDir, { recursive: true });

      args.push(
        // Stream mapping
        '-map', `[v${i}out]`,
        '-map', '0:a:0?',          // '?' makes audio optional (video-only files)
        // Video codec
        '-c:v',          'libx264',
        '-profile:v',    p.profile,
        '-preset',       'ultrafast',
        '-tune',         'fastdecode',
        '-b:v',          p.vbr,
        `-maxrate`,      `${Math.round(vbrKbps * 1.5)}k`,
        `-bufsize`,      `${Math.round(vbrKbps * 2)}k`,
        '-pix_fmt',      'yuv420p',
        '-sc_threshold', '0',
        '-g',            String(gopSize),
        '-keyint_min',   String(keyintMin),
        '-bf',           '0',
        // Audio codec
        '-c:a',   'aac',
        '-b:a',   p.abr,
        '-ac',    '2',
        '-ar',    '48000',
        // HLS muxer options
        '-hls_time',             String(HLS_TIME),
        '-hls_playlist_type',    'vod',
        '-hls_segment_filename', path.join(segDir, 'seg%03d.ts'),
        '-hls_flags',            'independent_segments',
      );
      // AES-128 encryption (per-output)
      if (keyInfoPath) args.push('-hls_key_info_file', keyInfoPath);
      args.push('-f', 'hls', path.join(segDir, 'index.m3u8'));
    }

    logger.info({ presets: presets.map(p => p.name), args: args.join(' ').slice(0, 400) },
      '[transcoder] transcodeMultiQuality — launching FFmpeg');

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    // Register in the active-process set so graceful shutdown can kill it.
    // ChildProcess.kill() has the same signature as fluent-ffmpeg's .kill(),
    // so the killAllFFmpeg() loop works without changes.
    _activeProcesses.add(proc);

    let stderrBuf = '';
    proc.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderrBuf += text;
      // Parse progress: "time=HH:MM:SS.ms" emitted by -stats
      if (onProgress && totalSecs > 0) {
        const m = text.match(/time=(\d+):(\d+):([\d.]+)/);
        if (m) {
          const secs = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
          onProgress(Math.min(1, secs / totalSecs));
        }
      }
    });

    proc.on('close', code => {
      _activeProcesses.delete(proc);
      if (code === 0) {
        logger.info({ presets: presets.map(p => p.name) }, '[transcoder] transcodeMultiQuality — done');
        resolve(presets.map(p => p.name));
      } else {
        const tail = stderrBuf.slice(-3000);
        reject(new Error(`FFmpeg multi-output exited with code ${code}\n${tail}`));
      }
    });

    proc.on('error', err => {
      _activeProcesses.delete(proc);
      reject(err);
    });
  });
}

function generateMasterPlaylist(outputDir, qualities) {
  const bitrateMap = { '360p':800000,'480p':1400000,'720p':2800000,'1080p':5000000,'1440p':10000000,'4k':20000000 };
  const resMap = { '360p':'640x360','480p':'854x480','720p':'1280x720','1080p':'1920x1080','1440p':'2560x1440','4k':'3840x2160' };
  const lines = ['#EXTM3U','#EXT-X-VERSION:3'];
  // Sort by bandwidth ascending per HLS spec §4.3.4.2
  const sorted = [...qualities].sort((a, b) => (bitrateMap[a] || 0) - (bitrateMap[b] || 0));
  for (const q of sorted) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bitrateMap[q]},RESOLUTION=${resMap[q]},NAME="${q}"`);
    lines.push(`${q}/index.m3u8`);
  }
  fs.writeFileSync(path.join(outputDir, 'master.m3u8'), lines.join('\n'));
}

function generateThumbnail(inputPath, outputDir, duration) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .screenshots({ timestamps: [Math.min(duration * 0.1, 5)], filename: 'thumb.jpg', folder: outputDir, size: '640x?' })
      .on('end', () => resolve())
      .on('error', reject);
  });
}

function generateSpriteSheet(inputPath, outputDir, duration) {
  const INTERVAL = 5;
  const THUMB_W  = 160;
  const THUMB_H  = 90;
  const COLUMNS  = 10;
  const totalFrames = Math.max(1, Math.ceil(duration / INTERVAL));
  const rows = Math.ceil(totalFrames / COLUMNS);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .addOptions([
        `-vf fps=1/${INTERVAL},scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=decrease,pad=${THUMB_W}:${THUMB_H}:(ow-iw)/2:(oh-ih)/2,tile=${COLUMNS}x${rows}`,
        `-frames:v 1`,
        `-q:v 5`,
      ])
      .output(path.join(outputDir, 'thumbs_sprite.jpg'))
      .on('end', () => {
        const meta = { interval: INTERVAL, columns: COLUMNS, rows, totalFrames, thumbW: THUMB_W, thumbH: THUMB_H };
        fs.writeFileSync(path.join(outputDir, 'thumbs_meta.json'), JSON.stringify(meta));
        resolve(meta);
      })
      .on('error', reject)
      .run();
  });
}

// Calidades mínimas garantizadas por plan — independientemente de la config global del admin.
// Esto evita que una mala configuración en system_config.transcoding.qualities
// deje a los workspaces sin las calidades a las que su plan les da derecho.
const PLAN_MIN_QUALITIES = {
  guest:      new Set(['360p', '480p', '720p']),
  starter:    new Set(['360p', '480p', '720p']),
  pro:        new Set(['360p', '480p', '720p', '1080p']),
  // Enterprise always gets all presets — 4K and 1440p included regardless of global config.
  enterprise: new Set(['360p', '480p', '720p', '1080p', '1440p', '4k']),
};

async function resolvePresetsForSource(videoInfo, workspaceId) {
  const tc = await getJsonConfig('transcoding', { qualities: ['360p', '480p', '720p', '1080p'] });
  const globalAllowed = new Set(Array.isArray(tc.qualities) ? tc.qualities : ['360p', '480p', '720p', '1080p']);

  // maxHeight caps which presets are eligible per plan tier.
  // 0 = no cap (use effectiveAllowed / customQualities only, bounded by source).
  let maxHeight = 0;
  let customQualities = null;
  let planMin = null; // minimum quality set guaranteed by plan

  if (workspaceId) {
    try {
      const ws = await db.prepare(`SELECT plan, settings FROM workspaces WHERE id = ?`).get(workspaceId);
      if (ws) {
        const plan = (ws.plan || 'starter').toLowerCase();
        // Obtener mínimos del plan (fallback si globalAllowed es muy restrictivo)
        planMin = PLAN_MIN_QUALITIES[plan] || PLAN_MIN_QUALITIES.starter;

        if (plan === 'starter') {
          maxHeight = 720; // starter capped at 720p
        } else if (plan === 'enterprise') {
          const settings = typeof ws.settings === 'string' ? JSON.parse(ws.settings || '{}') : (ws.settings || {});
          if (Array.isArray(settings.transcodingQualities) && settings.transcodingQualities.length > 0) {
            // Enterprise workspace with explicit custom quality list — use it exclusively
            customQualities = new Set(settings.transcodingQualities);
          }
          // Enterprise: no height cap
          maxHeight = 0;
        }
        // pro / any other plan: maxHeight=0 means use effectiveAllowed without an artificial cap
      }
    } catch (err) {
      logger.warn({ workspaceId, err: err.message }, 'resolvePresetsForSource: workspace lookup failed — using defaults');
    }
  } else {
    // Guest upload (no workspace) — capped at 720p, same limits as starter
    maxHeight = 720;
    planMin = PLAN_MIN_QUALITIES.guest;
  }

  // effectiveAllowed = unión de globalAllowed y los mínimos del plan.
  // Así, aunque el admin configure system_config con menos calidades, los planes
  // siempre tienen acceso a sus calidades mínimas garantizadas.
  const effectiveAllowed = planMin
    ? new Set([...globalAllowed, ...planMin])
    : globalAllowed;

  let presets;
  if (customQualities) {
    // Enterprise custom list: respect workspace setting but still don't upscale past source+100
    presets = QUALITY_PRESETS.filter(p => customQualities.has(p.name) && p.height <= videoInfo.height + 100);
  } else if (maxHeight > 0) {
    // Starter (or other capped plan): effectiveAllowed ∩ [≤maxHeight] ∩ [≤source+100]
    presets = QUALITY_PRESETS.filter(p =>
      effectiveAllowed.has(p.name) &&
      p.height <= maxHeight &&
      p.height <= videoInfo.height + 100
    );
  } else {
    // Pro / Enterprise (no cap): effectiveAllowed ∩ [≤source+100]
    presets = QUALITY_PRESETS.filter(p =>
      effectiveAllowed.has(p.name) &&
      p.height <= videoInfo.height + 100
    );
  }

  if (!presets.length) {
    // Safety fallback: pick the highest quality preset ≤ source resolution
    const fallback = [...QUALITY_PRESETS].reverse().find(p => p.height <= videoInfo.height) || QUALITY_PRESETS[0];
    presets = [fallback];
  }

  logger.info({ workspaceId, presets: presets.map(p => p.name), globalAllowed: [...globalAllowed], planMin: planMin ? [...planMin] : null, customQualities: customQualities ? [...customQualities] : null }, '[transcoder] resolvePresetsForSource result');
  return presets;
}

// ── Embedded track extraction ─────────────────────────────────────────────────

// ISO 639-2/1 language codes → display names
const LANG_NAMES = {
  und:'Desconocido',
  eng:'English',   en:'English',
  spa:'Español',   es:'Español',
  por:'Português', pt:'Português',
  fra:'Français',  fre:'Français', fr:'Français',
  deu:'Deutsch',   ger:'Deutsch',  de:'Deutsch',
  ita:'Italiano',  it:'Italiano',
  jpn:'日本語',    ja:'日本語',
  zho:'中文',      chi:'中文',     zh:'中文',
  kor:'한국어',    ko:'한국어',
  rus:'Русский',   ru:'Русский',
  ara:'العربية',   ar:'العربية',
  hin:'हिन्दी',   hi:'हिन्दी',
  nld:'Nederlands',dut:'Nederlands',nl:'Nederlands',
  pol:'Polski',    pl:'Polski',
  swe:'Svenska',   sv:'Svenska',
  nor:'Norsk',     nb:'Norsk',
  dan:'Dansk',     da:'Dansk',
  fin:'Suomi',     fi:'Suomi',
  tur:'Türkçe',    tr:'Türkçe',
  ces:'Čeština',   cze:'Čeština',  cs:'Čeština',
  slk:'Slovenčina',slo:'Slovenčina',
  hun:'Magyar',    hu:'Magyar',
  rum:'Română',    ron:'Română',   ro:'Română',
  ukr:'Українська',uk:'Українська',
  vie:'Tiếng Việt',vi:'Tiếng Việt',
  tha:'ไทย',       th:'ไทย',
  heb:'עברית',     he:'עברית',
  cat:'Català',    ca:'Català',
  lat:'Latino',
};

function langLabel(code, fallback) {
  if (fallback && fallback !== 'und') return fallback;
  return LANG_NAMES[code] || (code && code !== 'und' ? code.toUpperCase() : null);
}

/**
 * Probe a media file and return all audio + subtitle streams with their
 * ffprobe metadata (index, codec, language, title).
 */
function probeStreams(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(err);
      const audio = metadata.streams
        .filter(s => s.codec_type === 'audio')
        .map((s, i) => {
          const lang = s.tags?.language || s.tags?.lang || 'und';
          const rawTitle = s.tags?.title || s.tags?.handler_name || null;
          const title = rawTitle || langLabel(lang, null) || `Audio ${i + 1}`;
          return {
            index:    s.index,
            codec:    s.codec_name,
            language: lang,
            title,
            channels: s.channels || 2,
            default:  s.disposition?.default === 1,
          };
        });
      const subtitles = metadata.streams
        .filter(s => s.codec_type === 'subtitle')
        .map((s, i) => {
          const lang = s.tags?.language || s.tags?.lang || 'und';
          const rawTitle = s.tags?.title || s.tags?.handler_name || null;
          const title = rawTitle || langLabel(lang, null) || `Subtítulo ${i + 1}`;
          return {
            index:    s.index,
            codec:    s.codec_name,
            language: lang,
            title,
            default:  s.disposition?.default === 1,
          };
        });
      resolve({ audio, subtitles });
    });
  });
}

/**
 * Extract a single audio stream from inputPath to an HLS AAC playlist.
 * Returns the path to the generated index.m3u8.
 */
function extractAudioStream(inputPath, outputDir, streamIndex) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outputDir, { recursive: true });
    const m3u8Path   = path.join(outputDir, 'index.m3u8');
    const segPattern = path.join(outputDir, 'seg%03d.aac');

    const cmd = ffmpeg(inputPath)
      .noVideo()
      .addOptions([
        `-map 0:${streamIndex}`,
        `-c:a aac`,
        `-b:a 128k`,
        `-ac 2`,
        `-ar 48000`,
        `-hls_time 6`,
        `-hls_playlist_type vod`,
        `-hls_segment_filename ${segPattern}`,
        `-f hls`,
      ])
      .output(m3u8Path)
      .on('end',   () => { untrackProcess(cmd); resolve(m3u8Path); })
      .on('error', (err) => { untrackProcess(cmd); reject(err); });

    trackProcess(cmd);
    cmd.run();
  });
}

/**
 * Extract a single subtitle stream from inputPath to a WebVTT file.
 * Returns the path to the generated .vtt file.
 */
function extractSubtitleStream(inputPath, outputPath, streamIndex) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const cmd = ffmpeg(inputPath)
      .noVideo()
      .noAudio()
      .addOptions([`-map 0:${streamIndex}`])
      .outputFormat('webvtt')
      .output(outputPath)
      .on('end',   () => { untrackProcess(cmd); resolve(outputPath); })
      .on('error', (err) => { untrackProcess(cmd); reject(err); });

    trackProcess(cmd);
    cmd.run();
  });
}

/**
 * Extract all embedded audio and subtitle streams from a multi-track file
 * (MKV, MP4, etc.), register them in video_tracks, and rebuild master.m3u8.
 *
 * Only runs when the source has more than 1 audio stream OR any subtitle stream.
 * Single-audio files are handled by the normal HLS transcode pipeline.
 */
async function extractEmbeddedTracks(videoId, inputPath) {
  const { v4: uuidv4 } = require('uuid');
  const tracksDir = path.join(__dirname, 'videos', videoId, 'tracks');

  let streams;
  try {
    streams = await probeStreams(inputPath);
  } catch (err) {
    logger.warn({ videoId, err: err.message }, '[transcoder] probeStreams failed — skipping embedded track extraction');
    return;
  }

  const { audio, subtitles } = streams;
  const hasMultiAudio = audio.length > 1;
  const hasSubs       = subtitles.length > 0;

  if (!hasMultiAudio && !hasSubs) {
    logger.info({ videoId }, '[transcoder] Single audio, no subtitles — skipping embedded track extraction');
    return;
  }

  logger.info({ videoId, audioTracks: audio.length, subtitleTracks: subtitles.length },
    '[transcoder] Extracting embedded tracks…');

  // ── Audio tracks (only when there are multiple) ───────────────────────────
  if (hasMultiAudio) {
    for (let i = 0; i < audio.length; i++) {
      const a       = audio[i];
      const label   = a.title.slice(0, 80);
      const lang    = a.language.slice(0, 10);
      const outDir  = path.join(tracksDir, `audio_${i}`);

      try {
        const m3u8Path = await extractAudioStream(inputPath, outDir, a.index);
        const isDefault = (i === 0 || a.default) ? 1 : 0;

        // Unset existing defaults of same kind if this is default
        if (isDefault) {
          await db.prepare(`UPDATE video_tracks SET default_track = 0 WHERE video_id = ? AND kind = 'audio'`)
            .run(videoId);
        }

        await db.prepare(`
          INSERT INTO video_tracks (id, video_id, kind, language, label, src_path, format, default_track)
          VALUES (?, ?, 'audio', ?, ?, ?, 'hls', ?)
        `).run(uuidv4(), videoId, lang, label, m3u8Path, isDefault);

        logger.info({ videoId, lang, label }, `[transcoder] Audio track extracted: ${label}`);
      } catch (err) {
        logger.warn({ videoId, streamIndex: a.index, err: err.message },
          '[transcoder] Audio track extraction failed — skipping');
      }
    }
  }

  // ── Subtitle tracks ───────────────────────────────────────────────────────
  // Image-based subtitle codecs (PGS, VOBSUB) cannot be converted to WebVTT.
  const IMAGE_SUB_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'pgssub', 'xsub']);
  for (let i = 0; i < subtitles.length; i++) {
    const s       = subtitles[i];
    const label   = s.title.slice(0, 80);
    const lang    = s.language.slice(0, 10);
    const vttPath = path.join(tracksDir, `sub_${i}_${lang}.vtt`);

    if (IMAGE_SUB_CODECS.has(s.codec)) {
      logger.info({ videoId, codec: s.codec, lang }, '[transcoder] Skipping image-based subtitle (cannot convert to WebVTT)');
      continue;
    }

    try {
      await extractSubtitleStream(inputPath, vttPath, s.index);
      const isDefault = (i === 0 || s.default) ? 1 : 0;

      if (isDefault) {
        await db.prepare(`UPDATE video_tracks SET default_track = 0 WHERE video_id = ? AND kind = 'subtitle'`)
          .run(videoId);
      }

      await db.prepare(`
        INSERT INTO video_tracks (id, video_id, kind, language, label, src_path, format, default_track)
        VALUES (?, ?, 'subtitle', ?, ?, ?, 'vtt', ?)
      `).run(uuidv4(), videoId, lang, label, vttPath, isDefault);

      logger.info({ videoId, lang, label }, `[transcoder] Subtitle track extracted: ${label}`);
    } catch (err) {
      logger.warn({ videoId, streamIndex: s.index, err: err.message },
        '[transcoder] Subtitle track extraction failed — skipping');
    }
  }

  // ── Rebuild master.m3u8 to include new audio tracks ───────────────────────
  if (hasMultiAudio) {
    await rebuildMasterPlaylist(videoId).catch(err =>
      logger.warn({ videoId, err: err.message }, '[transcoder] rebuildMasterPlaylist failed after extraction')
    );
  }
}

async function processVideo(videoId, inputPath, title, options = {}) {
  const workspaceId  = options.workspaceId  || null;
  const s3SourceKey  = options.s3SourceKey  || null;
  const _rawProgress = options.onProgress   || (() => {});
  const onProgress   = (pct) => Promise.resolve(_rawProgress(pct)).catch(() => {});
  const outputDir    = path.join(__dirname, 'videos', videoId);

  // If the source was uploaded to S3 (multi-server mode), download it to a
  // local temp file first. The temp file is cleaned up in the finally block.
  let effectiveInputPath = inputPath;
  let tempSourcePath     = null;
  if (s3SourceKey) {
    const ext = path.extname(s3SourceKey) || path.extname(inputPath || '') || '.mp4';
    // Usar outputDir en lugar de /tmp para evitar llenar tmpfs en archivos grandes (4-10GB).
    // El volumen sv_videos tiene más espacio disponible que el tmpfs del contenedor.
    fs.mkdirSync(outputDir, { recursive: true });
    tempSourcePath     = path.join(outputDir, `_source${ext}`);
    effectiveInputPath = tempSourcePath;
    logger.info({ videoId, s3SourceKey, tempSourcePath }, 'Downloading source from S3 to outputDir');
    await s3.downloadSourceFile(s3SourceKey, tempSourcePath);
    logger.info({ videoId, tempSourcePath }, 'Source downloaded — starting transcode');
  }

  fs.mkdirSync(outputDir, { recursive: true });

  try {
    const info = await probeVideo(effectiveInputPath);
    logger.info({ videoId, width: info.width, height: info.height }, 'Source probed');

    await db.prepare(`UPDATE videos SET duration=?, size=?, status='transcoding' WHERE id=?`)
      .run(info.duration, info.size, videoId);
    await onProgress(5);

    // Thumbnail runs first (fast, needed for UI). Sprite sheet runs in background
    // in parallel with transcoding so it doesn't add to the total wall-clock time.
    await generateThumbnail(effectiveInputPath, outputDir, info.duration).catch(() => {});
    await onProgress(10);

    // ── Early thumbnail S3 upload ────────────────────────────────────────────
    // Upload thumb.jpg to S3 immediately (before encoding starts) so the CDN
    // URL is valid during transcoding. This lets the dashboard show a thumbnail
    // even when the API and worker run in separate containers without shared storage.
    if (s3.isS3Enabled()) {
      try {
        const thumbPath = path.join(outputDir, 'thumb.jpg');
        if (fs.existsSync(thumbPath)) {
          const thumbCdnUrl = await s3.uploadFile(thumbPath, workspaceId, videoId, 'thumb.jpg');
          await db.prepare(`UPDATE videos SET thumbnail_url = ? WHERE id = ?`).run(thumbCdnUrl, videoId);
          logger.info({ videoId, thumbCdnUrl }, 'Thumbnail uploaded to S3 early');
        }
      } catch (e) {
        logger.warn({ videoId, err: e.message }, 'Early thumbnail S3 upload failed — will be uploaded with full batch');
      }
    }

    const spritePromise = generateSpriteSheet(effectiveInputPath, outputDir, info.duration).catch(err =>
      logger.warn({ videoId, err: err.message }, 'Sprite sheet skipped')
    );

    const hlsKey   = crypto.randomBytes(16);
    const hlsKeyId = crypto.randomBytes(24).toString('base64url');
    const keyBinPath  = path.join(outputDir, 'hls.key');
    const keyInfoPath = path.join(outputDir, 'hls.keyinfo');
    fs.writeFileSync(keyBinPath, hlsKey);
    const keyUrl = `${config.appUrl}/api/videos/${videoId}/hlskey/${hlsKeyId}`;
    fs.writeFileSync(keyInfoPath, `${keyUrl}\n${keyBinPath}\n`);

    const presets = await resolvePresetsForSource(info, workspaceId);
    const totalCpus = os.cpus().length;
    const done = [];

    // Store expected quality count so the dashboard can show X/Y progress
    await db.prepare(`UPDATE videos SET qualities_expected=? WHERE id=?`).run(presets.length, videoId).catch(() => {});

    // ── Phase 1: encode highest supported quality first ───────────────────────
    // Primary = the best quality the source supports within the plan limits.
    // This way users can watch in the best available resolution immediately
    // while secondary (lower) qualities encode in the background.
    const primaryPreset = [...presets].sort((a, b) => b.height - a.height)[0];
    const secondaryPresets = presets.filter(p => p.name !== primaryPreset.name);
    // 0 = FFmpeg auto (uses all logical CPUs) — no artificial cap
    const primaryThreads = 0;

    logger.info({ videoId, primary: primaryPreset.name, secondary: secondaryPresets.map(p => p.name), totalCpus }, 'Transcoding — primary quality first');

    try {
      await transcodeQuality(effectiveInputPath, outputDir, primaryPreset, info, keyInfoPath,
        (ratio) => onProgress(Math.round(20 + ratio * 55)), primaryThreads);
      done.push(primaryPreset.name);
    } catch (err) {
      logger.error({ videoId, preset: primaryPreset.name, err: err.message }, 'Primary quality transcode failed');
    }

    if (done.length === 0) {
      throw new Error('All quality presets failed — no playable output produced');
    }

    // ── FAST PATH: Mark video ready immediately after primary quality ────────────
    // Users can watch as soon as ONE quality is available. Secondary qualities and
    // S3 upload all happen in the background. This cuts perceived wait time from
    // "all qualities + S3 upload" to just "primary quality transcode" (~50% faster).
    await db.prepare(`UPDATE videos SET qualities=? WHERE id=?`).run(JSON.stringify(done), videoId);
    await rebuildMasterPlaylist(videoId, done).catch(() => {});

    // Save HLS key immediately so the player can decrypt the primary quality
    await db.prepare(`UPDATE videos SET hls_key=?, hls_key_id=? WHERE id=?`)
      .run(hlsKey.toString('base64'), hlsKeyId, videoId);
    // NOTE: keyBinPath and keyInfoPath are intentionally NOT deleted here.
    // They must remain on disk until ALL secondary qualities have been encoded,
    // because transcodeQuality() references keyInfoPath for the -hls_key_info_file
    // FFmpeg option. Deletion happens AFTER Phase 2 completes below.

    // If S3 is enabled, upload primary quality immediately so the video is
    // accessible even when DELETE_LOCAL_AFTER_S3=1 cleans up local files.
    let hlsCdnUrl = null;
    let s3ObjectPrefix = null;
    if (s3.isS3Enabled() && done.length) {
      try {
        const up = await s3.uploadVideoDirectory(outputDir, workspaceId, videoId);
        hlsCdnUrl = up.cdnMasterUrl;
        s3ObjectPrefix = up.objectPrefix;
        logger.info({ videoId, hlsCdnUrl }, 'Primary quality uploaded to S3 — marking ready');
      } catch (e) {
        logger.error({ videoId, err: e.message }, 'S3 upload of primary failed — keeping local');
      }
    }

    // Mark the video READY NOW so users can immediately watch it
    if (hlsCdnUrl) {
      await db.prepare(`
        UPDATE videos
        SET status = CASE WHEN publish_at IS NOT NULL AND publish_at > FLOOR(EXTRACT(EPOCH FROM NOW())) THEN 'scheduled' ELSE 'ready' END,
            qualities=?, hls_cdn_url=?, s3_object_prefix=?, transcoding_pct=NULL
        WHERE id=?
      `).run(JSON.stringify(done), hlsCdnUrl, s3ObjectPrefix, videoId);
    } else {
      await db.prepare(`
        UPDATE videos
        SET status = CASE WHEN publish_at IS NOT NULL AND publish_at > FLOOR(EXTRACT(EPOCH FROM NOW())) THEN 'scheduled' ELSE 'ready' END,
            qualities=?, transcoding_pct=NULL
        WHERE id=?
      `).run(JSON.stringify(done), videoId);
    }

    logger.info({ videoId, primaryQuality: done[0] }, 'Video marked READY — secondary qualities encoding in background');
    // Fire notifications immediately so users know the video is available
    _notifyOwner(videoId, title, 'ready').catch(() => {});
    _fireWebhook(videoId, 'video.ready', { videoId, title, qualities: done }).catch(() => {});
    _createInAppNotification(videoId, title, 'ready').catch(() => {});

    await onProgress(75);

    // ── Phase 2: secondary qualities — single FFmpeg multi-output pass ───────────
    // transcodeMultiQuality reads the source file ONCE and encodes all secondary
    // qualities simultaneously using filter_complex + split. For a 4-10 GB source
    // this eliminates repeated disk reads, cutting total Phase 2 time from
    // Σ(each quality) down to ≈ max(each quality) — typically 2-4× faster.
    //
    // On failure (e.g. OOM on very large files) we automatically fall back to the
    // proven sequential approach so the video still completes successfully.
    if (secondaryPresets.length) {
      const sortedSecondary = [...secondaryPresets].sort((a, b) => a.height - b.height);

      let multiOutputSucceeded = false;

      if (sortedSecondary.length >= 2) {
        // ── FAST PATH: one FFmpeg process, all secondary qualities at once ────
        try {
          logger.info({ videoId, qualities: sortedSecondary.map(p => p.name) },
            '[transcoder] Phase 2 — multi-output FFmpeg (single read)');
          const names = await transcodeMultiQuality(
            effectiveInputPath, outputDir, sortedSecondary, info, keyInfoPath, () => {}
          );
          done.push(...names);
          multiOutputSucceeded = true;

          // Update DB + rebuild playlist with all new qualities at once
          await db.prepare(`UPDATE videos SET qualities=? WHERE id=?`).run(JSON.stringify(done), videoId);
          await rebuildMasterPlaylist(videoId, done).catch(() => {});
          logger.info({ videoId, qualities: names, total: done.length }, 'All secondary qualities ready (multi-output)');

          // Upload all new quality dirs to S3 in parallel
          if (s3.isS3Enabled()) {
            await Promise.all(names.map(async name => {
              try {
                await s3.uploadQualityDir(path.join(outputDir, name), workspaceId, videoId, name);
                logger.info({ videoId, quality: name }, 'Secondary quality uploaded to S3 (multi-output batch)');
              } catch (e) {
                logger.warn({ videoId, quality: name, err: e.message }, 'S3 upload of secondary quality failed — se reintentará en sync final');
              }
            }));

            // CRITICAL: re-upload master.m3u8 with ALL qualities and immediately
            // invalidate CloudFront. Without this, CloudFront keeps serving the
            // Phase-1 master.m3u8 (primary quality only) and players see only 1 quality.
            try {
              await s3.uploadMasterPlaylist(path.join(outputDir, 'master.m3u8'), workspaceId, videoId);
              logger.info({ videoId, qualities: done }, '[transcoder] master.m3u8 re-uploaded after Phase 2 multi-output — CDN invalidated');
            } catch (e) {
              logger.warn({ videoId, err: e.message }, 'Phase 2 multi-output master.m3u8 re-upload failed — will retry in final sync');
            }
          }
        } catch (err) {
          logger.warn({ videoId, err: err.message },
            '[transcoder] Multi-output FFmpeg failed — falling back to sequential');
          multiOutputSucceeded = false;
        }
      }

      // ── FALLBACK / SINGLE SECONDARY: sequential encode, one quality at a time ─
      if (!multiOutputSucceeded) {
        logger.info({ videoId, qualities: sortedSecondary.map(p => p.name) },
          '[transcoder] Phase 2 — sequential fallback');
        for (const preset of sortedSecondary) {
          // Skip qualities that already completed in the failed multi-output attempt
          if (done.includes(preset.name)) continue;
          try {
            const name = await transcodeQuality(effectiveInputPath, outputDir, preset, info, keyInfoPath, () => {}, 0);
            done.push(name);
            await db.prepare(`UPDATE videos SET qualities=? WHERE id=?`).run(JSON.stringify(done), videoId);
            await rebuildMasterPlaylist(videoId, done).catch(() => {});
            logger.info({ videoId, quality: name, total: done.length }, 'Secondary quality ready (sequential)');
            if (s3.isS3Enabled()) {
              try {
                await s3.uploadQualityDir(path.join(outputDir, name), workspaceId, videoId, name);
                logger.info({ videoId, quality: name }, 'Secondary quality uploaded to S3 incrementally');
              } catch (e) {
                logger.warn({ videoId, quality: name, err: e.message }, 'Incremental S3 upload failed — se reintentará en sync final');
              }
            }
          } catch (err) {
            logger.error({ videoId, preset: preset.name, err: err.message }, 'Secondary quality transcode failed — continuando con las siguientes');
          }
        }

        // CRITICAL: re-upload master.m3u8 after all sequential qualities finish
        // and immediately invalidate CloudFront. Mirrors the multi-output path above.
        if (s3.isS3Enabled()) {
          try {
            await s3.uploadMasterPlaylist(path.join(outputDir, 'master.m3u8'), workspaceId, videoId);
            logger.info({ videoId, qualities: done }, '[transcoder] master.m3u8 re-uploaded after Phase 2 sequential — CDN invalidated');
          } catch (e) {
            logger.warn({ videoId, err: e.message }, 'Phase 2 sequential master.m3u8 re-upload failed — will retry in final sync');
          }
        }
      }
    }

    // ── Clean up key files now that ALL qualities are encoded ───────────────────
    // Safe to delete here: keyInfoPath was needed by every transcodeQuality() call
    // above (both primary and all secondary). Deleting earlier caused secondary
    // qualities to fail with "No such file or directory" from FFmpeg.
    try { fs.unlinkSync(keyBinPath); } catch {}
    try { fs.unlinkSync(keyInfoPath); } catch {}

    await onProgress(90);

    // ── Wait for sprite sheet + extract embedded tracks ──────────────────────────
    // Multi-audio and embedded subtitle extraction is a Pro/Enterprise feature.
    // Guest uploads (no workspace) and Starter plan workspaces only get the
    // primary audio stream from the normal HLS transcode pipeline.
    const MULTI_TRACK_PLANS = new Set(['pro', 'enterprise']);
    let canExtractTracks = false;
    if (workspaceId) {
      try {
        const wsRow = await db.prepare(`SELECT plan FROM workspaces WHERE id = ?`).get(workspaceId);
        const wsPlan = (wsRow?.plan || 'starter').toLowerCase();
        canExtractTracks = MULTI_TRACK_PLANS.has(wsPlan);
        if (!canExtractTracks) {
          logger.info({ videoId, plan: wsPlan }, '[transcoder] Skipping embedded track extraction — plan does not include multi-audio/subtitles');
        }
      } catch (err) {
        logger.warn({ videoId, err: err.message }, '[transcoder] Plan lookup failed for track extraction — skipping');
      }
    } else {
      logger.info({ videoId }, '[transcoder] Skipping embedded track extraction — guest upload (no workspace)');
    }

    await Promise.all([
      spritePromise,
      canExtractTracks
        ? extractEmbeddedTracks(videoId, effectiveInputPath).catch(err =>
            logger.warn({ videoId, err: err.message }, '[transcoder] extractEmbeddedTracks failed — continuing')
          )
        : Promise.resolve(),
    ]);

    // Final rebuild with all qualities + audio tracks
    await rebuildMasterPlaylist(videoId, done);

    // Final S3 sync with all qualities + cleanup local files
    if (s3.isS3Enabled() && done.length) {
      try {
        const finalUp = await s3.uploadVideoDirectory(outputDir, workspaceId, videoId);
        // Safety-net invalidation: ensures the final master.m3u8 (with all qualities
        // + embedded audio/subtitle tracks) is served by CDN immediately, even if
        // the Phase-2 uploadMasterPlaylist call above was skipped or failed.
        await s3.invalidateCDN([`/${finalUp.objectPrefix}/master.m3u8`]).catch(() => {});
        await db.prepare(`UPDATE videos SET qualities=?, hls_cdn_url=?, s3_object_prefix=? WHERE id=?`)
          .run(JSON.stringify(done), finalUp.cdnMasterUrl, finalUp.objectPrefix, videoId);
        if (process.env.DELETE_LOCAL_AFTER_S3 === '1') {
          try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (e) {
            logger.warn({ videoId, err: e.message }, 'Local cleanup after final S3 upload failed');
          }
        }
      } catch (e) {
        logger.error({ videoId, err: e.message }, 'Final S3 upload failed — keeping local files');
      }
    }

    // Delete original local upload file + S3 source
    try { fs.unlinkSync(inputPath); } catch {}
    if (s3SourceKey) {
      s3.deleteObject(s3SourceKey).catch(err =>
        logger.warn({ videoId, s3SourceKey, err: err.message }, 'S3 source cleanup failed after transcode')
      );
    }

    // Update final qualities in DB
    await db.prepare(`UPDATE videos SET qualities=? WHERE id=?`).run(JSON.stringify(done), videoId);
    logger.info({ videoId, qualities: done }, 'Transcode complete — all qualities ready');

  } catch (err) {
    // Remove partial output directory — unusable without a complete transcode
    if (outputDir) {
      try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch {}
    }
    await db.prepare(`UPDATE videos SET status='error', transcoding_pct=NULL WHERE id=?`).run(videoId);
    logger.error({ videoId, err }, 'Fatal transcode error');
    _notifyOwner(videoId, title, 'error').catch(() => {});
    _fireWebhook(videoId, 'video.failed', { videoId, title, error: err.message }).catch(() => {});
    _createInAppNotification(videoId, title, 'error').catch(() => {});
    throw err;
  } finally {
    // Always clean up the temp source file downloaded from S3
    if (tempSourcePath) {
      try { fs.unlinkSync(tempSourcePath); } catch {}
    }
  }
}

async function _createInAppNotification(videoId, title, status) {
  try {
    const { createNotification } = require('./routes/notifications');
    const row = await db.prepare(`
      SELECT w.owner_id, v.workspace_id FROM videos v
      LEFT JOIN workspaces w ON w.id = v.workspace_id
      WHERE v.id = ?
    `).get(videoId);
    if (!row?.owner_id) return;
    const isReady = status === 'ready';
    await createNotification({
      userId: row.owner_id,
      workspaceId: row.workspace_id || null,
      kind: isReady ? 'success' : 'error',
      title: isReady ? `"${title}" ya está listo` : `Error al procesar "${title}"`,
      body: isReady ? 'Tu video ha sido procesado y está disponible.' : 'Hubo un error al transcodificar el video.',
      link: isReady ? `/dashboard#/videos` : null,
    });
  } catch {}
}

async function _fireWebhook(videoId, event, payload) {
  try {
    const video = await db.prepare(`SELECT workspace_id FROM videos WHERE id = ?`).get(videoId);
    if (!video?.workspace_id) return;
    const { deliverWebhook } = require('./services/webhooks');
    await deliverWebhook(video.workspace_id, event, payload);
  } catch (e) {
    logger.warn({ videoId, event, err: e.message }, 'Webhook delivery failed in transcoder');
  }
}

async function _notifyOwner(videoId, title, status) {
  const row = await db.prepare(`
    SELECT u.email, u.name, w.settings FROM videos v
    JOIN workspaces w ON w.id = v.workspace_id
    JOIN users u ON u.id = w.owner_id
    WHERE v.id = ?
  `).get(videoId);
  if (!row?.email) return;

  // Respect workspace notification settings
  let wsSettings = {};
  try { wsSettings = JSON.parse(row.settings || '{}'); } catch {}
  const emailEnabled = wsSettings.emailNotifications !== false; // default ON
  const notifyReady  = wsSettings.notifyOnReady !== false;      // default ON
  const notifyError  = wsSettings.notifyOnError !== false;      // default ON

  if (status === 'ready' && emailEnabled && notifyReady) {
    await sendTranscodeComplete(row.email, title, `/watch/${videoId}`);
  } else if (status !== 'ready' && emailEnabled && notifyError) {
    await sendTranscodeError(row.email, title);
  }
}

/**
 * rebuildMasterPlaylist — re-exported from routes/tracks.js logic.
 * Regenerates master.m3u8 for a video, including any uploaded audio tracks
 * registered in the video_tracks table.
 *
 * Called by routes/tracks.js after adding or deleting an audio track.
 * Also exported here so other modules (e.g. admin cleanup) can call it.
 */
async function rebuildMasterPlaylist(videoId, qualitiesOverride = null) {
  let qualities = qualitiesOverride || null;
  if (!qualities) {
    const video = await db.prepare(`SELECT qualities FROM videos WHERE id = ?`).get(videoId);
    if (!video) return;
    qualities = JSON.parse(video.qualities || '[]');
  }
  const audioTracks = await db.prepare(
    `SELECT * FROM video_tracks WHERE video_id = ? AND kind = 'audio' ORDER BY created_at ASC`
  ).all(videoId);
  const subtitleTracks = await db.prepare(
    `SELECT * FROM video_tracks WHERE video_id = ? AND kind = 'subtitle' ORDER BY created_at ASC`
  ).all(videoId);

  const bitrateMap = { '360p':800000,'480p':1400000,'720p':2800000,'1080p':5000000,'1440p':10000000,'4k':20000000 };
  const resMap     = { '360p':'640x360','480p':'854x480','720p':'1280x720','1080p':'1920x1080','1440p':'2560x1440','4k':'3840x2160' };

  // NOTE: We intentionally do NOT include #EXT-X-MEDIA:TYPE=SUBTITLES in the manifest.
  // The HLS spec requires SUBTITLES URIs to point to segment playlists (m3u8), not plain
  // VTT files. Our subtitles are single VTT files served via a proxy — pointing them here
  // would cause iOS native player to try to parse the VTT as an m3u8, silently fail, and
  // show broken entries in its subtitle picker alongside the working <track> elements.
  // Subtitles are delivered exclusively via HTML <track> elements (added by loadSubtitles()
  // in the player), which iOS native player (webkitEnterFullscreen) reads correctly.
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];

  if (audioTracks.length) {
    const anyCustomDefault = audioTracks.some(t => t.default_track);
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="und",NAME="Original",` +
      `DEFAULT=${anyCustomDefault ? 'NO' : 'YES'},AUTOSELECT=${anyCustomDefault ? 'NO' : 'YES'}`
    );
    for (const t of audioTracks) {
      const isDefault = !!t.default_track ? 'YES' : 'NO';
      const relPath   = path.relative(path.join(__dirname, 'videos', videoId), t.src_path);
      lines.push(
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="${t.language}",NAME="${t.label}",DEFAULT=${isDefault},AUTOSELECT=${isDefault},URI="${relPath}"`
      );
    }
  }

  const audioAttr = audioTracks.length ? ',AUDIO="audio"' : '';
  // Sort by bandwidth ascending (HLS spec §4.3.4.2 recommends ordering from lowest to highest)
  const sortedQualities = [...qualities].sort((a, b) => (bitrateMap[a] || 0) - (bitrateMap[b] || 0));
  for (const q of sortedQualities) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bitrateMap[q]},RESOLUTION=${resMap[q]},NAME="${q}"${audioAttr}`);
    lines.push(`${q}/index.m3u8`);
  }

  const outputDir  = path.join(__dirname, 'videos', videoId);
  const masterPath = path.join(outputDir, 'master.m3u8');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(masterPath, lines.join('\n'));
  logger.info({ videoId, qualities, audioTracks: audioTracks.length, subtitleTracks: subtitleTracks.length }, '[transcoder] master.m3u8 rebuilt');
}

module.exports = { processVideo, probeVideo, generateSpriteSheet, resolvePresetsForSource, QUALITY_PRESETS, killAllFFmpeg, rebuildMasterPlaylist };
