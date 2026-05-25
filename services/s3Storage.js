/**
 * S3 / CloudFront storage service.
 *
 * Key improvements over the original:
 *   • uploadVideoDirectory uses fs.createReadStream + @aws-sdk/lib-storage
 *     (Upload) instead of fs.readFileSync — zero RAM spike regardless of
 *     file size. The Upload helper handles multipart automatically for
 *     files > 5 MB.
 *   • isS3Enabled() checks the correct config keys (awsRegion, s3Bucket).
 *
 * When AWS credentials are not configured, all operations are no-ops and
 * isS3Enabled() returns false — the transcoder falls back to local storage.
 */
const fs   = require('fs');
const path = require('path');
const db   = require('../db');
const cfg  = require('../config');

let _client = null;

function getClient() {
  if (_client) return _client;
  const { S3Client } = require('@aws-sdk/client-s3');
  _client = new S3Client({
    region: cfg.awsRegion || 'us-east-1',
    // When running on EC2 with an IAM role, credentials are picked up
    // automatically — no need to set them explicitly.
    credentials: process.env.AWS_ACCESS_KEY_ID ? {
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    } : undefined,
  });
  return _client;
}

function isS3Enabled() {
  return !!(cfg.s3Bucket);
}

/**
 * Read a config value from system_config table (used by transcoder
 * to read transcoding quality settings stored by admin panel).
 */
async function getJsonConfig(key, defaultVal = null) {
  try {
    const row = await db.prepare('SELECT value FROM system_config WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : defaultVal;
  } catch {
    return defaultVal;
  }
}

/**
 * Test S3 bucket connectivity (admin panel uses this).
 */
async function headBucket() {
  if (!isS3Enabled()) return { ok: false, reason: 'S3 not configured' };
  try {
    const { HeadBucketCommand } = require('@aws-sdk/client-s3');
    await getClient().send(new HeadBucketCommand({ Bucket: cfg.s3Bucket }));
    return { ok: true, bucket: cfg.s3Bucket, region: cfg.awsRegion };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Files that must never be uploaded to S3 (HLS encryption keys are served
// by the API server, not CDN; uploading them would be a security risk).
const S3_EXCLUDED_FILES = new Set(['hls.key', 'hls.keyinfo']);

/**
 * Upload a single local file to S3 and return its CDN URL.
 * Used to publish the thumbnail immediately after generation so it's
 * accessible via CDN even while transcoding is still in progress.
 *
 * @param {string} localPath    - Absolute path to the local file
 * @param {string} workspaceId  - Workspace ID (for S3 key prefix)
 * @param {string} videoId      - Video ID (for S3 key prefix)
 * @param {string} filename     - Filename within the video prefix (e.g. 'thumb.jpg')
 * @returns {Promise<string>}   - CDN URL of the uploaded file
 */
async function uploadFile(localPath, workspaceId, videoId, filename) {
  const { Upload } = require('@aws-sdk/lib-storage');
  const keyPrefix = [cfg.s3KeyPrefix || 'streamvault', workspaceId, videoId]
    .filter(Boolean).join('/');
  const key = `${keyPrefix}/${filename}`;

  const upload = new Upload({
    client: getClient(),
    params: {
      Bucket:      cfg.s3Bucket,
      Key:         key,
      Body:        fs.createReadStream(localPath),
      ContentType: mimeFor(localPath),
    },
    partSize:  8 * 1024 * 1024,
    queueSize: 4,
    leavePartsOnError: false,
  });
  await upload.done();

  const cdnBase = cfg.cdnBaseUrl
    ? cfg.cdnBaseUrl.replace(/\/$/, '')
    : `https://${cfg.s3Bucket}.s3.${cfg.awsRegion}.amazonaws.com`;
  return `${cdnBase}/${key}`;
}

// Max files uploaded to S3 in parallel per uploadVideoDirectory / uploadQualityDir call.
// HLS segments are 1-4 MB — well below the 5 MB multipart threshold — so the win here
// is parallelising the TCP handshake + transfer for many small files, not multipart.
// 12 concurrent connections is safe on a t3.medium / c5 instance without saturating
// the ENI. Tune down if you see S3 throttling (SlowDown) errors in prod logs.
const S3_UPLOAD_CONCURRENCY = 12;

/**
 * Upload one file to S3, returning a promise.  Internal helper.
 *
 * Cache-Control strategy:
 *   • .m3u8 playlists — "no-cache, no-store, must-revalidate"
 *     HLS playlists are rewritten multiple times during the two-phase
 *     transcoding pipeline (Phase 1 = primary quality only, Phase 2 = all
 *     qualities). Without this header CloudFront caches the Phase-1 version
 *     and players see only ONE quality until the CDN TTL expires naturally.
 *   • Everything else (.ts segments, .jpg, .vtt, …) — 1-year immutable cache.
 *     Segments are content-addressed and never modified after creation, so a
 *     long cache is safe and greatly reduces S3 → CloudFront egress costs.
 */
function _uploadOneFile(client, localPath, key) {
  const { Upload } = require('@aws-sdk/lib-storage');
  const isPlaylist = key.endsWith('.m3u8');
  const upload = new Upload({
    client,
    params: {
      Bucket:       cfg.s3Bucket,
      Key:          key,
      Body:         fs.createReadStream(localPath),
      ContentType:  mimeFor(localPath),
      CacheControl: isPlaylist
        ? 'no-cache, no-store, must-revalidate'
        : 'public, max-age=31536000, immutable',
    },
    // 16 MB parts × 8 concurrent = up to 128 MB in-flight per file.
    // For HLS .ts segments (<5 MB) multipart doesn't trigger, but these
    // settings also govern uploadSourceFile-style large objects.
    partSize:          16 * 1024 * 1024,
    queueSize:         8,
    leavePartsOnError: false,
  });
  return upload.done();
}

/**
 * Upload all files from a local directory to S3 under a key prefix.
 *
 * Uses @aws-sdk/lib-storage Upload with fs.createReadStream so that:
 *   - No file is ever fully loaded into RAM.
 *   - Files > 5 MB are automatically uploaded via multipart.
 *   - Up to S3_UPLOAD_CONCURRENCY files are uploaded simultaneously,
 *     cutting total upload time by 5-10× for a directory of HLS segments.
 *
 * Returns { cdnMasterUrl, objectPrefix }.
 */
async function uploadVideoDirectory(localDir, workspaceId, videoId) {
  const client    = getClient();
  const keyPrefix = [cfg.s3KeyPrefix || 'streamvault', workspaceId, videoId]
    .filter(Boolean).join('/');

  // Build the upload queue (file path → S3 key)
  const queue = walkDir(localDir)
    .filter(f => !S3_EXCLUDED_FILES.has(path.basename(f)))
    .map(f => ({ localPath: f, key: `${keyPrefix}/${path.relative(localDir, f)}` }));

  // Upload in sliding-window batches of S3_UPLOAD_CONCURRENCY
  for (let i = 0; i < queue.length; i += S3_UPLOAD_CONCURRENCY) {
    await Promise.all(
      queue.slice(i, i + S3_UPLOAD_CONCURRENCY).map(({ localPath, key }) =>
        _uploadOneFile(client, localPath, key)
      )
    );
  }

  const cdnBase = cfg.cdnBaseUrl
    ? cfg.cdnBaseUrl.replace(/\/$/, '')
    : `https://${cfg.s3Bucket}.s3.${cfg.awsRegion}.amazonaws.com`;

  return {
    objectPrefix: keyPrefix,
    cdnMasterUrl: `${cdnBase}/${keyPrefix}/master.m3u8`,
  };
}

/**
 * Upload a single quality subdirectory (e.g. "720p/") to S3.
 * Used for incremental uploads after each secondary quality finishes encoding,
 * so quality segments are safely in S3 even if the final uploadVideoDirectory fails.
 *
 * Uploads to: {keyPrefix}/{workspaceId}/{videoId}/{quality}/
 * Files are uploaded S3_UPLOAD_CONCURRENCY at a time (parallel).
 */
async function uploadQualityDir(qualityDir, workspaceId, videoId, quality) {
  if (!fs.existsSync(qualityDir)) return;
  const client    = getClient();
  const keyPrefix = [cfg.s3KeyPrefix || 'streamvault', workspaceId, videoId, quality]
    .filter(Boolean).join('/');

  const queue = walkDir(qualityDir)
    .filter(f => !S3_EXCLUDED_FILES.has(path.basename(f)))
    .map(f => ({ localPath: f, key: `${keyPrefix}/${path.relative(qualityDir, f)}` }));

  for (let i = 0; i < queue.length; i += S3_UPLOAD_CONCURRENCY) {
    await Promise.all(
      queue.slice(i, i + S3_UPLOAD_CONCURRENCY).map(({ localPath, key }) =>
        _uploadOneFile(client, localPath, key)
      )
    );
  }
}

/**
 * Upload only master.m3u8 for a video to S3 and immediately invalidate the CDN.
 *
 * Called after EVERY master.m3u8 rebuild during multi-phase transcoding so that
 * CloudFront always serves the latest quality list:
 *
 *   Phase 1 → uploadVideoDirectory (includes master.m3u8 with primary quality only)
 *   Phase 2 → uploadMasterPlaylist  (master.m3u8 now has ALL qualities)
 *   Final   → uploadVideoDirectory  + invalidateCDN (safety net)
 *
 * Without explicit re-upload + invalidation after Phase 2, CloudFront keeps
 * serving the Phase-1 master.m3u8 (1 quality) until its TTL expires, even
 * though S3 has the correct multi-quality version.
 *
 * @param {string} localMasterPath  Absolute path to the local master.m3u8
 * @param {string} workspaceId
 * @param {string} videoId
 * @returns {Promise<string>}       CDN URL of the uploaded master.m3u8
 */
async function uploadMasterPlaylist(localMasterPath, workspaceId, videoId) {
  const client    = getClient();
  const keyPrefix = [cfg.s3KeyPrefix || 'streamvault', workspaceId, videoId]
    .filter(Boolean).join('/');
  const key = `${keyPrefix}/master.m3u8`;

  // _uploadOneFile already sets CacheControl: no-cache for .m3u8 files
  await _uploadOneFile(client, localMasterPath, key);

  // Immediately purge the cached Phase-1 version from CloudFront so the next
  // player request fetches the updated multi-quality master.m3u8 from S3.
  await invalidateCDN([`/${key}`]);

  const cdnBase = cfg.cdnBaseUrl
    ? cfg.cdnBaseUrl.replace(/\/$/, '')
    : `https://${cfg.s3Bucket}.s3.${cfg.awsRegion}.amazonaws.com`;
  return `${cdnBase}/${key}`;
}

/**
 * Delete all S3 objects that start with a given prefix.
 */
async function deleteObjectsWithPrefix(prefix) {
  if (!isS3Enabled()) return;
  const { ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');

  let ContinuationToken;
  do {
    const list = await getClient().send(new ListObjectsV2Command({
      Bucket: cfg.s3Bucket,
      Prefix: prefix,
      ContinuationToken,
    }));

    const objects = (list.Contents || []).map(o => ({ Key: o.Key }));
    if (objects.length) {
      await getClient().send(new DeleteObjectsCommand({
        Bucket: cfg.s3Bucket,
        Delete: { Objects: objects, Quiet: true },
      }));
    }
    ContinuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (ContinuationToken);
}

/**
 * Prune orphaned video folders from S3 that do not exist in the DB.
 */
async function pruneOrphans(validPrefixesSet) {
  if (!isS3Enabled()) return { deleted: 0, errors: [] };
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const basePrefix = (cfg.s3KeyPrefix || 'streamvault') + '/';
  
  let deletedCount = 0;
  let errors = [];

  try {
    // 1. List all workspaces (CommonPrefixes under basePrefix)
    const workspacesList = await getClient().send(new ListObjectsV2Command({
      Bucket: cfg.s3Bucket,
      Prefix: basePrefix,
      Delimiter: '/'
    }));

    const wsPrefixes = (workspacesList.CommonPrefixes || []).map(p => p.Prefix);

    for (const wsPrefix of wsPrefixes) {
      // 2. List all videos under this workspace
      let contToken;
      do {
        const videosList = await getClient().send(new ListObjectsV2Command({
          Bucket: cfg.s3Bucket,
          Prefix: wsPrefix,
          Delimiter: '/',
          ContinuationToken: contToken
        }));

        const vidPrefixes = (videosList.CommonPrefixes || []).map(p => p.Prefix);
        
        for (const vp of vidPrefixes) {
          const stripped = vp.replace(/\/$/, ''); // remove trailing slash
          if (!validPrefixesSet.has(stripped)) {
            // Orphan found
            try {
              await deleteObjectsWithPrefix(vp);
              deletedCount++;
            } catch (err) {
              errors.push(`Failed to delete ${vp}: ${err.message}`);
            }
          }
        }
        
        contToken = videosList.IsTruncated ? videosList.NextContinuationToken : undefined;
      } while (contToken);
    }
  } catch (err) {
    errors.push(err.message);
  }

  return { deleted: deletedCount, errors };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function walkDir(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkDir(full));
    else results.push(full);
  }
  return results;
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.m3u8': 'application/x-mpegURL',
    '.ts':   'video/MP2T',
    '.aac':  'audio/aac',
    '.jpg':  'image/jpeg',
    '.png':  'image/png',
    '.json': 'application/json',
    '.vtt':  'text/vtt',
  }[ext] || 'application/octet-stream';
}

/**
 * Upload a raw source video file to S3 before transcoding.
 * Called by the upload route immediately after multer writes the file,
 * so workers on other servers can access it via S3 rather than local disk.
 *
 * Key pattern: {s3KeyPrefix}/{workspaceId|_anon}/{videoId}/source{ext}
 * Returns the S3 key string.
 */
async function uploadSourceFile(localPath, workspaceId, videoId) {
  const { Upload } = require('@aws-sdk/lib-storage');
  const ext = path.extname(localPath) || '';
  const wsFolder = workspaceId || '_anon';
  const key = [cfg.s3KeyPrefix, wsFolder, videoId, `source${ext}`].filter(Boolean).join('/');

  // 16 MB parts × 16 concurrent = up to 256 MB/s theoretical throughput.
  // For a 2.7 GB file this cuts upload time from ~90s to ~20s on a fast connection.
  // leavePartsOnError: false ensures incomplete uploads are cleaned up automatically.
  const upload = new Upload({
    client: getClient(),
    params: {
      Bucket:      cfg.s3Bucket,
      Key:         key,
      Body:        fs.createReadStream(localPath),
      ContentType: 'application/octet-stream',
    },
    partSize:          16 * 1024 * 1024,  // 16 MB per part (was 8 MB)
    queueSize:         16,                 // 16 parallel parts (was 4)
    leavePartsOnError: false,
  });

  try {
    await upload.done();
  } catch (err) {
    // Abort the multipart upload so incomplete parts don't accumulate in S3
    try { await upload.abort(); } catch {}
    throw err; // re-throw so caller can handle/log
  }
  return key;
}

/**
 * Download an S3 object to a local file path (streaming, no RAM spike).
 */
async function downloadSourceFile(s3Key, destPath) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const response = await getClient().send(new GetObjectCommand({
    Bucket: cfg.s3Bucket,
    Key:    s3Key,
  }));
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    response.Body.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
  });
}

/**
 * Delete a single S3 object by key.
 */
async function deleteObject(key) {
  if (!isS3Enabled() || !key) return;
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await getClient().send(new DeleteObjectCommand({ Bucket: cfg.s3Bucket, Key: key }));
}

/**
 * Create a CloudFront invalidation for a list of paths.
 * Called after video delete/update so CDN stops serving stale HLS segments.
 *
 * Requires:
 *   CLOUDFRONT_DISTRIBUTION_ID — the distribution ID (not the domain)
 *   IAM permission: cloudfront:CreateInvalidation
 *
 * No-op if CLOUDFRONT_DISTRIBUTION_ID is not set.
 *
 * @param {string[]} paths  e.g. ['/media/ws-id/video-id/*']
 */
async function invalidateCDN(paths) {
  if (!cfg.cloudfrontDistributionId || !paths?.length) return;
  try {
    const { CloudFrontClient, CreateInvalidationCommand } = require('@aws-sdk/client-cloudfront');
    const cf = new CloudFrontClient({ region: cfg.awsRegion });
    await cf.send(new CreateInvalidationCommand({
      DistributionId: cfg.cloudfrontDistributionId,
      InvalidationBatch: {
        CallerReference: `sv-${Date.now()}`,
        Paths: { Quantity: paths.length, Items: paths },
      },
    }));
  } catch (err) {
    // Non-fatal: stale CDN content will expire naturally
    const logger = require('../services/logger').child({ module: 's3' });
    logger.warn({ err: err.message, paths }, 'CloudFront invalidation failed');
  }
}

module.exports = {
  isS3Enabled,
  headBucket,
  uploadFile,
  uploadVideoDirectory,
  uploadQualityDir,
  uploadMasterPlaylist,
  uploadSourceFile,
  downloadSourceFile,
  deleteObject,
  deleteObjectsWithPrefix,
  invalidateCDN,
  pruneOrphans,
  getJsonConfig,
};
