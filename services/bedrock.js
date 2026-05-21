/**
 * Amazon Bedrock — Content Intelligence Service
 *
 * Uses Claude (via Bedrock) to analyze a video transcription and generate:
 *   • ai_title       — SEO-optimized title suggestion
 *   • ai_description — SEO-optimized description (150-200 words)
 *   • ai_summary     — JSON array of chapter suggestions with timestamps
 *
 * Requirements:
 *   • AWS_REGION env var (same region where Bedrock is enabled)
 *   • IAM permissions: bedrock:InvokeModel on the Claude model ARN
 *   • No extra API key needed — uses the same AWS credentials as S3
 *
 * Model: anthropic.claude-3-haiku-20240307-v1:0
 *   → Fastest + cheapest Claude 3 model, ideal for batch content generation.
 *   → Can be overridden with BEDROCK_MODEL_ID env var.
 *
 * Fallback: if Bedrock is not configured or the call fails, returns null
 * gracefully — the transcription job still completes successfully.
 */

const cfg = require('../config');
const logger = require('./logger').child({ module: 'bedrock' });

// Default to Claude Haiku 4.5 — fast, cheap, great for structured output
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

let _client = null;

function getClient() {
  if (_client) return _client;
  const { BedrockRuntimeClient } = require('@aws-sdk/client-bedrock-runtime');
  _client = new BedrockRuntimeClient({
    region: cfg.awsRegion || process.env.AWS_REGION || 'us-east-1',
    // Uses IAM role on EC2 or AWS_ACCESS_KEY_ID/SECRET env vars automatically
  });
  return _client;
}

/**
 * Check if Bedrock is usable in the current environment.
 * Requires AWS region to be configured (same as S3).
 */
function isBedrockEnabled() {
  return !!(cfg.awsRegion || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION);
}

/**
 * Invoke Claude on Bedrock with a prompt and return the text response.
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function invokeClause(prompt) {
  const { InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
  const modelId = cfg.bedrockModelId || DEFAULT_MODEL;

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens:        1024,
    temperature:       0.3,   // Low temperature for consistent structured output
    messages: [
      { role: 'user', content: prompt },
    ],
  };

  const command = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept:      'application/json',
    body:        JSON.stringify(payload),
  });

  const response = await getClient().send(command);
  const body     = JSON.parse(Buffer.from(response.body).toString('utf-8'));
  return body.content?.[0]?.text || '';
}

/**
 * Analyze a video transcription with Claude and return AI-generated metadata.
 *
 * @param {object} params
 * @param {string} params.vttContent   — Full VTT subtitle content
 * @param {string} params.videoTitle   — Current video title (for context)
 * @param {number} params.durationSecs — Video duration in seconds
 * @param {string} [params.language]   — Language of the transcription (default: 'es')
 *
 * @returns {Promise<{aiTitle: string, aiDescription: string, aiChapters: Array}>|null}
 */
async function analyzeTranscription({ vttContent, videoTitle, durationSecs, language = 'es' }) {
  if (!isBedrockEnabled()) {
    logger.warn('AWS region not configured — skipping AI analysis');
    return null;
  }

  // Extract plain text from VTT (strip timestamps and formatting)
  const plainText = vttContent
    .split('\n')
    .filter(line => !line.includes('-->') && !line.match(/^\d+$/) && line.trim() !== 'WEBVTT' && line.trim() !== '')
    .join(' ')
    .replace(/<[^>]+>/g, '')
    .trim()
    .slice(0, 8000); // Claude 3 Haiku context limit safety margin

  if (plainText.length < 50) {
    logger.warn('Transcription too short for AI analysis — skipping');
    return null;
  }

  const langLabel = language === 'es' ? 'Spanish' : language === 'en' ? 'English' : language;
  const durationMin = Math.round(durationSecs / 60);

  const prompt = `You are a professional video content strategist. Analyze the following video transcription and generate structured metadata.

VIDEO CONTEXT:
- Current title: "${videoTitle}"
- Duration: approximately ${durationMin} minutes
- Language: ${langLabel}

TRANSCRIPTION:
${plainText}

Generate a JSON response with EXACTLY this structure (no markdown, no explanation, just valid JSON):
{
  "title": "SEO-optimized title (max 70 chars, compelling, includes main keyword)",
  "description": "SEO-optimized description (150-200 words, includes keywords naturally, describes value for viewer)",
  "chapters": [
    { "title": "Chapter title", "start_time": 0 },
    { "title": "Chapter title", "start_time": 120 }
  ]
}

Rules for chapters:
- Generate 3-8 chapters based on topic changes in the transcription
- start_time is in SECONDS (integer)
- First chapter always starts at 0
- Last chapter should not exceed ${Math.floor(durationSecs)} seconds
- Chapter titles should be concise (max 50 chars) and descriptive
- If the video is under 3 minutes, generate 2-3 chapters maximum

Respond ONLY with the JSON object. No markdown code blocks.`;

  try {
    const raw = await invokeClause(prompt);

    // Parse the JSON response — Claude sometimes adds whitespace
    const jsonStr = raw.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/, '');
    const parsed  = JSON.parse(jsonStr);

    // Validate and sanitize the response
    const aiTitle       = (parsed.title       || '').slice(0, 200).trim();
    const aiDescription = (parsed.description || '').slice(0, 2000).trim();
    const aiChapters    = Array.isArray(parsed.chapters)
      ? parsed.chapters
          .filter(c => typeof c.title === 'string' && typeof c.start_time === 'number')
          .map(c => ({
            title:      c.title.slice(0, 100).trim(),
            start_time: Math.max(0, Math.floor(c.start_time)),
          }))
          .sort((a, b) => a.start_time - b.start_time)
          .slice(0, 20) // max 20 chapters
      : [];

    return { aiTitle, aiDescription, aiChapters };

  } catch (err) {
    logger.error({ err: err.message }, 'analyzeTranscription error');
    return null;
  }
}

module.exports = { analyzeTranscription, isBedrockEnabled };
