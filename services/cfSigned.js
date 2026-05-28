/**
 * CloudFront Signed Cookies/URLs Service
 *
 * Generates short-lived signed cookies for CloudFront so HLS segments
 * are only accessible to authorized viewers from allowed domains.
 *
 * Requirements:
 *   - A CloudFront Key Pair (RSA 2048-bit) configured as a Trusted Key Group
 *   - The private key stored as a file or env var
 *   - CloudFront distribution configured with "Restrict Viewer Access" → Trusted Key Group
 *
 * ENV VARS:
 *   CF_KEY_PAIR_ID      — CloudFront Key Pair ID (e.g. K2JCJMDEHXQW7F)
 *   CF_PRIVATE_KEY      — PEM-encoded RSA private key (inline, newlines as \n)
 *   CF_PRIVATE_KEY_PATH — OR path to the .pem file on disk
 *   CF_COOKIE_DOMAIN    — Cookie domain (e.g. .cloudfront.net or your custom domain)
 *   CF_SIGNED_EXPIRY_HOURS — Cookie lifetime in hours (default: 4)
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const cfg = require('../config');
const logger = require('./logger').child({ module: 'cf-signed' });

// ── Load signing configuration ───────────────────────────────────────────────
const KEY_PAIR_ID = process.env.CF_KEY_PAIR_ID || '';
const COOKIE_DOMAIN = process.env.CF_COOKIE_DOMAIN || '';
const EXPIRY_HOURS = parseInt(process.env.CF_SIGNED_EXPIRY_HOURS || '4', 10);

let _privateKey = null;

function getPrivateKey() {
  if (_privateKey) return _privateKey;
  
  // Try inline env var first (with \n → real newlines)
  if (process.env.CF_PRIVATE_KEY) {
    _privateKey = process.env.CF_PRIVATE_KEY.replace(/\\n/g, '\n');
    return _privateKey;
  }
  
  // Try file path
  const keyPath = process.env.CF_PRIVATE_KEY_PATH || '/app/keys/cf-private-key.pem';
  try {
    _privateKey = fs.readFileSync(keyPath, 'utf8');
    return _privateKey;
  } catch {
    return null;
  }
}

/**
 * Check if CloudFront signing is configured and available.
 */
function isSigningEnabled() {
  return !!(KEY_PAIR_ID && getPrivateKey() && cfg.cdnBaseUrl);
}

/**
 * Create a CloudFront custom policy JSON for a resource pattern.
 * @param {string} resourceUrl - The URL pattern to allow (with wildcards)
 * @param {number} expireTime  - Unix timestamp when access expires
 * @returns {string} Policy JSON
 */
function createPolicy(resourceUrl, expireTime) {
  return JSON.stringify({
    Statement: [{
      Resource: resourceUrl,
      Condition: {
        DateLessThan: { 'AWS:EpochTime': expireTime },
      },
    }],
  });
}

/**
 * Sign a policy string with the CloudFront private key.
 * @param {string} policy - The JSON policy string
 * @returns {string} Base64url-encoded signature
 */
function signPolicy(policy) {
  const key = getPrivateKey();
  if (!key) throw new Error('CF_PRIVATE_KEY not available');
  
  const sign = crypto.createSign('RSA-SHA1');
  sign.update(policy);
  const signature = sign.sign(key, 'base64');
  
  // Convert to URL-safe base64
  return signature
    .replace(/\+/g, '-')
    .replace(/=/g, '_')
    .replace(/\//g, '~');
}

/**
 * Base64url encode a string (CloudFront format).
 */
function base64urlEncode(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/=/g, '_')
    .replace(/\//g, '~');
}

/**
 * Generate CloudFront signed cookies for a video's HLS content.
 * 
 * The cookies grant access to all files under the video's S3 prefix:
 *   https://cdn.example.com/streamvault/{workspaceId}/{videoId}/*
 *
 * @param {string} workspaceId - The workspace owning the video
 * @param {string} videoId     - The video ID
 * @param {object} [options]   - Optional overrides
 * @param {number} [options.expiryHours] - Custom expiry (default: CF_SIGNED_EXPIRY_HOURS)
 * @param {string} [options.s3ObjectPrefix] - Exact S3 prefix (overrides workspaceId/videoId pattern)
 * @returns {{ cookies: object, expiresAt: number } | null} Signed cookies or null if not configured
 */
function generateSignedCookies(workspaceId, videoId, options = {}) {
  if (!isSigningEnabled()) return null;
  
  const hours = options.expiryHours || EXPIRY_HOURS;
  const expiresAt = Math.floor(Date.now() / 1000) + (hours * 3600);
  
  // Resource pattern — allow access to all files under this video's prefix.
  // When s3ObjectPrefix is provided (from DB), use it directly for accuracy.
  // Otherwise fall back to the convention: {s3KeyPrefix}/{workspaceId}/{videoId}/*
  let resourceUrl;
  if (options.s3ObjectPrefix) {
    resourceUrl = `${cfg.cdnBaseUrl}/${options.s3ObjectPrefix}/*`;
  } else {
    const prefix = cfg.s3KeyPrefix || 'streamvault';
    resourceUrl = `${cfg.cdnBaseUrl}/${prefix}/${workspaceId}/${videoId}/*`;
  }
  
  const policy = createPolicy(resourceUrl, expiresAt);
  const signature = signPolicy(policy);
  const encodedPolicy = base64urlEncode(policy);
  
  const cookies = {
    'CloudFront-Policy': encodedPolicy,
    'CloudFront-Signature': signature,
    'CloudFront-Key-Pair-Id': KEY_PAIR_ID,
  };
  
  return { cookies, expiresAt, resourceUrl };
}

/**
 * Generate a single CloudFront signed URL for a specific resource.
 * Useful for one-off downloads or when cookies aren't practical.
 *
 * @param {string} url     - The full CloudFront URL to sign
 * @param {number} [expiryHours] - Hours until expiry
 * @returns {string} The signed URL with query params
 */
function generateSignedUrl(url, expiryHours) {
  if (!isSigningEnabled()) return url; // fallback to unsigned
  
  const hours = expiryHours || EXPIRY_HOURS;
  const expiresAt = Math.floor(Date.now() / 1000) + (hours * 3600);
  
  const policy = createPolicy(url, expiresAt);
  const signature = signPolicy(policy);
  const encodedPolicy = base64urlEncode(policy);
  
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}Policy=${encodedPolicy}&Signature=${signature}&Key-Pair-Id=${KEY_PAIR_ID}`;
}

/**
 * Get cookie options for Set-Cookie headers.
 * @param {number} expiresAt - Unix timestamp
 * @returns {object} Cookie options for res.cookie()
 */
function getCookieOptions(expiresAt) {
  return {
    domain: COOKIE_DOMAIN || undefined,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'None', // Required for cross-origin embed iframes
    expires: new Date(expiresAt * 1000),
  };
}

module.exports = {
  isSigningEnabled,
  generateSignedCookies,
  generateSignedUrl,
  getCookieOptions,
  COOKIE_DOMAIN,
};
