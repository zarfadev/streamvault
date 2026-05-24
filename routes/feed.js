/**
 * RSS 2.0 / Podcast feed per workspace channel.
 *
 * GET /feed/:slug          — RSS 2.0 with <enclosure> + iTunes podcast tags
 * GET /feed/:slug/atom     — Atom 1.0 (future; 404 for now)
 *
 * No auth required. Only returns public, ready videos.
 * Max 100 items per feed (newest first).
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const config  = require('../config');
const logger  = require('../services/logger').child({ module: 'feed' });

const MAX_ITEMS = 100;

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function rfcDate(unixSec) {
  return new Date((unixSec || 0) * 1000).toUTCString();
}

function itunesDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

router.get('/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase().trim();
    if (!slug) return res.status(404).send('Not found');

    const ws = await db.prepare(
      `SELECT w.id, w.name, w.slug, w.settings, w.avatar_url AS ws_avatar,
              u.channel_name, u.avatar_url AS user_avatar
       FROM workspaces w LEFT JOIN users u ON u.id = w.owner_id WHERE w.slug = ?`
    ).get(slug);

    if (!ws) return res.status(404).send('Channel not found');

    let s = {};
    try { s = JSON.parse(ws.settings || '{}'); } catch {}

    if (s.channelEnabled === false) {
      return res.status(403).send('Channel is disabled');
    }

    const displayName = ws.channel_name || ws.name || 'StreamVault Channel';

    const videos = await db.prepare(
      `SELECT id, title, description, duration, size, created_at, updated_at, qualities, hls_cdn_url, thumbnail_url
       FROM videos
       WHERE workspace_id = ? AND visibility = 'public' AND status = 'ready' AND (dmca_suspended IS NULL OR dmca_suspended = FALSE)
       ORDER BY created_at DESC
       LIMIT ?`
    ).all(ws.id, MAX_ITEMS);

    const base = config.appUrl || `${req.protocol}://${req.get('host')}`;

    // Channel image: workspace avatar first, fallback to owner's user avatar
    const rawAvatar = ws.ws_avatar || ws.user_avatar || null;
    // base64 data URLs can't be used in RSS enclosures — only serve HTTP URLs
    const channelImage = rawAvatar && rawAvatar.startsWith('http')
      ? rawAvatar
      : null;

    const channelLink = `${base}/c/${slug}`;
    const feedLink    = `${base}/feed/${slug}`;
    const description = esc(s.channelDescription || `Videos publicados en ${displayName}`);

    const items = videos.map(v => {
      const watchUrl  = `${base}/watch/${v.id}`;
      const cdnBase   = v.hls_cdn_url ? v.hls_cdn_url.replace(/\/master\.m3u8$/i, '') : null;
      const thumbUrl  = v.thumbnail_url || (cdnBase ? `${cdnBase}/thumb.jpg` : `${base}/videos/${v.id}/thumb.jpg`);
      const videoUrl  = v.hls_cdn_url || `${base}/videos/${v.id}/master.m3u8`; // HLS playlist as enclosure
      const sizeBytes = v.size || 0;
      const title     = esc(v.title || 'Untitled');
      const desc      = esc(v.description || '');
      const pubDate   = rfcDate(v.created_at);
      const duration  = itunesDuration(v.duration);
      const guid      = watchUrl;

      return `
    <item>
      <title>${title}</title>
      <link>${esc(watchUrl)}</link>
      <guid isPermaLink="true">${esc(guid)}</guid>
      <description><![CDATA[${v.description || v.title || ''}]]></description>
      <pubDate>${pubDate}</pubDate>
      <enclosure url="${esc(videoUrl)}" length="${sizeBytes}" type="application/x-mpegURL"/>
      <media:content url="${esc(thumbUrl)}" medium="image"/>
      ${duration ? `<itunes:duration>${duration}</itunes:duration>` : ''}
      <itunes:summary><![CDATA[${v.description || v.title || ''}]]></itunes:summary>
      <itunes:image href="${esc(thumbUrl)}"/>
    </item>`;
    }).join('');

    const imageBlock = channelImage
      ? `<image>
      <url>${esc(channelImage)}</url>
      <title>${esc(displayName)}</title>
      <link>${esc(channelLink)}</link>
    </image>
    <itunes:image href="${esc(channelImage)}"/>`
      : '';

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:media="http://search.yahoo.com/mrss/"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(displayName)}</title>
    <link>${esc(channelLink)}</link>
    <description>${description}</description>
    <language>es</language>
    <atom:link href="${esc(feedLink)}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <generator>StreamVault</generator>
    ${imageBlock}
    <itunes:author>${esc(displayName)}</itunes:author>
    <itunes:category text="Technology"/>
    <itunes:explicit>no</itunes:explicit>${items}
  </channel>
</rss>`;

    res.set('Content-Type', 'application/rss+xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300'); // 5 min cache
    res.send(xml);
  } catch (err) {
    logger.error({ err }, 'RSS feed error');
    res.status(500).send('Internal server error');
  }
});

module.exports = router;
