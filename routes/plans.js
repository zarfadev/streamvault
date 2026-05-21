/**
 * GET /api/plans — Public endpoint.
 *
 * Devuelve los planes actuales y la configuración de uploads anónimos (guest)
 * para que la landing page refleje siempre lo que el Super Admin ha definido.
 *
 * Fuente de verdad (prioridad):
 *   1. system_config key 'plans'        ← configurado desde el panel Super Admin
 *   2. config.js defaults               ← fallback cuando no hay override en DB
 *   3. system_config key 'guest_config' ← config uploads anónimos
 *
 * IMPORTANTE: Las claves de features usan la convención canónica:
 *   foldersEnabled, playlistsEnabled, webhooksEnabled, etc.
 *   (mismas que system_config.features y checkFeature.js)
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const config  = require('../config');
const { PLAN_FEATURE_DEFAULTS } = require('../middleware/checkFeature');

// Helper para leer una clave de system_config
async function getSystemConfig(key, defaultVal = null) {
  try {
    const row = await db.prepare(`SELECT value FROM system_config WHERE key = ?`).get(key);
    return row?.value ? JSON.parse(row.value) : defaultVal;
  } catch { return defaultVal; }
}

router.get('/', async (req, res) => {
  // Leer overrides de planes desde la DB
  let dbPlans = await getSystemConfig('plans', null);

  // Leer configuración de uploads anónimos desde la DB
  let guestConfig = await getSystemConfig('guest_config', null);

  // Defaults de guest config
  const defaultGuest = {
    enabled:       true,
    maxFileSizeMB: 2048,   // 2 GB
    expiryHours:   24,
    maxVideos:     3,
  };

  const guest = {
    enabled:       guestConfig?.enabled       ?? defaultGuest.enabled,
    maxFileSizeMB: guestConfig?.maxFileSizeMB ?? defaultGuest.maxFileSizeMB,
    expiryHours:   guestConfig?.expiryHours   ?? defaultGuest.expiryHours,
    maxVideos:     guestConfig?.maxVideos     ?? defaultGuest.maxVideos,
  };

  /**
   * Merge plan: DB override sobre defaults de config.js.
   * Los features del plan siempre usan claves canónicas (foldersEnabled, etc.)
   */
  const merge = (key) => {
    const base    = config.plans[key] || {};
    const over    = dbPlans?.[key] || {};

    // Features: prioridad DB > defaults por plan
    const dbFeatures  = over.features || {};
    const defFeatures = PLAN_FEATURE_DEFAULTS[key] || {};

    // Merge: para cada clave canónica usa el valor de DB si existe, si no el default
    const features = { ...defFeatures, ...dbFeatures };

    return {
      name:           over.name        || base.name        || key,
      description:    over.description || base.description || '',
      price:          over.price       ?? base.price       ?? 0,
      highlighted:    over.highlighted ?? (key === 'pro'),
      badge:          over.badge       || (key === 'pro' ? 'Más popular' : null),

      // Límites de recursos
      maxVideos:      over.maxVideos      ?? base.maxVideos      ?? 0,
      maxStorageGB:   over.maxStorageGB   ?? base.maxStorageGB   ?? 0,
      maxBandwidthGB: over.maxBandwidthGB ?? base.maxBandwidthGB ?? 0,
      maxFileSizeMB:  over.maxFileSizeMB  ?? base.maxFileSizeMB  ?? 10240,
      maxWorkspaces:  over.maxWorkspaces  ?? base.maxWorkspaces  ?? 1,
      maxMembers:     over.maxMembers     ?? base.maxMembers     ?? 1,

      // Features con nombres canónicos
      features,
    };
  };

  res.json({
    starter:    merge('starter'),
    pro:        merge('pro'),
    enterprise: merge('enterprise'),
    guest,
  });
});

module.exports = router;
