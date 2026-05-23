/**
 * Middleware para validar permisos jerárquicos de features
 * Valida: Global (system_config.features) → Plan (system_config.plans.<plan>.features)
 *
 * NAMING CONVENTION:
 *   - Global keys (system_config.features):  foldersEnabled, playlistsEnabled, ...
 *   - Plan keys (plans.<plan>.features):      foldersEnabled, playlistsEnabled, ...
 *   - Middleware arg (featureName):           'folders', 'playlists', ...
 *
 * El mapeo featureName → globalKey vive en FEATURE_NAME_MAP.
 */
const logger = require('../services/logger').child({ module: 'checkFeature' });

const { getDynConfig } = require('../services/dynamicConfig');

/**
 * Mapeo: nombre corto del middleware → clave en system_config.features Y plans.<plan>.features
 */
const FEATURE_NAME_MAP = {
  'folders':        'foldersEnabled',
  'playlists':      'playlistsEnabled',
  'webhooks':       'webhooksEnabled',
  'transcriptions': 'transcriptionsEnabled',
  'downloadLinks':  'downloadLinksEnabled',
  'watermark':      'watermarkEnabled',
  'analytics':      'analyticsEnabled',
  'embed':          'embedEnabled',
  'ads':            'adsEnabled',
  'bulkOperations': 'bulkOperationsEnabled',
  'apiKeys':        'apiKeysEnabled',
  'tracks':         'tracksEnabled',
  'subtitleTracks': 'subtitleTracksEnabled',
  'multiAudio':     'multiAudioEnabled',
  'invitations':    'invitationsEnabled',
  'referrals':      'referralEnabled',
  'multiWorkspace': 'multiWorkspaceEnabled',
  'customDomain':   'customDomainEnabled',
};

/**
 * Defaults por plan cuando no hay configuración en la DB.
 * Sirve como fallback para workspaces existentes antes de que el admin
 * configure explícitamente los features del plan.
 */
const PLAN_FEATURE_DEFAULTS = {
  starter: {
    foldersEnabled:        true,
    playlistsEnabled:      true,
    webhooksEnabled:       false,
    transcriptionsEnabled: false,
    downloadLinksEnabled:  true,
    watermarkEnabled:      false,
    analyticsEnabled:      'basic',
    embedEnabled:          'branded',
    adsEnabled:            false,
    bulkOperationsEnabled: true,
    apiKeysEnabled:        false,
    tracksEnabled:         false,
    subtitleTracksEnabled: false,
    multiAudioEnabled:     false,
    invitationsEnabled:    false,
    referralEnabled:       true,
    multiWorkspaceEnabled: false,
    customDomainEnabled:   false,
  },
  pro: {
    foldersEnabled:        true,
    playlistsEnabled:      true,
    webhooksEnabled:       true,
    transcriptionsEnabled: true,
    downloadLinksEnabled:  true,
    watermarkEnabled:      true,
    analyticsEnabled:      'full',
    embedEnabled:          'unbranded',
    adsEnabled:            true,
    bulkOperationsEnabled: true,
    apiKeysEnabled:        true,
    tracksEnabled:         true,
    subtitleTracksEnabled: true,
    multiAudioEnabled:     false,
    invitationsEnabled:    true,
    referralEnabled:       true,
    multiWorkspaceEnabled: false,
    customDomainEnabled:   false,
  },
  enterprise: {
    foldersEnabled:        true,
    playlistsEnabled:      true,
    webhooksEnabled:       true,
    transcriptionsEnabled: true,
    downloadLinksEnabled:  true,
    watermarkEnabled:      true,
    analyticsEnabled:      'full',
    embedEnabled:          'custom',
    adsEnabled:            true,
    bulkOperationsEnabled: true,
    apiKeysEnabled:        true,
    tracksEnabled:         true,
    subtitleTracksEnabled: true,
    multiAudioEnabled:     true,
    invitationsEnabled:    true,
    referralEnabled:       true,
    multiWorkspaceEnabled: true,
    customDomainEnabled:   true,
  },
};

/**
 * Resuelve si un feature está activo para un workspace dado.
 * Sigue la cadena: global → plan.
 *
 * @param {string} featureName - Nombre corto ('webhooks', 'folders', …)
 * @param {object} workspace   - Objeto workspace con { plan }
 * @returns {{ allowed: boolean, reason: string, value: any }}
 */
async function resolveFeature(featureName, workspace) {
  // ── 1. Clave canónica ─────────────────────────────────────────────────────
  const canonicalKey = FEATURE_NAME_MAP[featureName] || `${featureName}Enabled`;

  // ── 2. Check global ───────────────────────────────────────────────────────
  const globalEnabled = await getDynConfig(`features.${canonicalKey}`, true);
  if (globalEnabled === false) {
    return { allowed: false, reason: 'FEATURE_DISABLED_GLOBALLY', value: false };
  }

  // ── 3. Check plan ─────────────────────────────────────────────────────────
  const planName = workspace?.plan || 'starter';
  const planConfig = await getDynConfig(`plans.${planName}`, null);

  // Obtener features del plan (DB config o defaults)
  const planFeatures = planConfig?.features || PLAN_FEATURE_DEFAULTS[planName] || {};

  // El valor puede ser: true/false (bool) o 'full'/'basic'/'branded'/'unbranded'/'custom' (string)
  // Soportar tanto el formato canónico (apiKeysEnabled) como el legado (apiKeys)
  // para compatibilidad con datos anteriores en la DB
  const legacyKey = featureName; // nombre corto sin 'Enabled' (ej: 'apiKeys', 'webhooks')
  const featureValue = planFeatures[canonicalKey] !== undefined
    ? planFeatures[canonicalKey]
    : planFeatures[legacyKey]; // fallback al nombre corto legado

  const planEnabled =
    featureValue === true ||
    featureValue === 'full' ||
    featureValue === 'basic' ||
    featureValue === 'unbranded' ||
    featureValue === 'branded' ||
    featureValue === 'custom';

  if (!planEnabled) {
    return {
      allowed: false,
      reason:  'FEATURE_NOT_IN_PLAN',
      value:   featureValue,
    };
  }

  return { allowed: true, reason: 'OK', value: featureValue };
}

/**
 * Middleware factory para verificar si un feature está disponible.
 * @param {string} featureName - Nombre corto del feature ('webhooks', 'folders', …)
 */
function checkFeature(featureName) {
  return async (req, res, next) => {
    try {
      const workspace = req.workspace;
      if (!workspace) {
        return res.status(400).json({
          error: 'Workspace no encontrado',
          code:  'WORKSPACE_REQUIRED',
        });
      }

      const { allowed, reason, value } = await resolveFeature(featureName, workspace);

      if (!allowed) {
        if (reason === 'FEATURE_DISABLED_GLOBALLY') {
          return res.status(403).json({
            error: `La funcionalidad "${featureName}" está deshabilitada en el sistema`,
            code:  'FEATURE_DISABLED_GLOBALLY',
          });
        }
        return res.status(403).json({
          error:           `Tu plan "${workspace.plan}" no incluye "${featureName}". Actualiza tu plan para acceder.`,
          code:            'FEATURE_NOT_IN_PLAN',
          requiredUpgrade: true,
          currentPlan:     workspace.plan,
        });
      }

      req.featureValue = value;
      next();
    } catch (error) {
      logger.error({ feature: featureName, err: error.message }, 'checkFeature error');
      return res.status(500).json({
        error: 'Error al verificar permisos',
        code:  'PERMISSION_CHECK_ERROR',
      });
    }
  };
}

/**
 * Middleware para verificar múltiples features (OR logic).
 * El usuario necesita AL MENOS UNO de los features listados.
 */
function checkAnyFeature(...featureNames) {
  return async (req, res, next) => {
    const workspace = req.workspace;
    if (!workspace) {
      return res.status(400).json({ error: 'Workspace no encontrado', code: 'WORKSPACE_REQUIRED' });
    }

    for (const featureName of featureNames) {
      try {
        const { allowed, value } = await resolveFeature(featureName, workspace);
        if (allowed) {
          req.featureValue = value;
          return next();
        }
      } catch (error) {
        logger.error({ feature: featureName, err: error.message }, 'checkAnyFeature error');
      }
    }

    return res.status(403).json({
      error: `Tu plan no incluye ninguna de las funcionalidades requeridas: ${featureNames.join(', ')}`,
      code:  'NO_REQUIRED_FEATURES',
    });
  };
}

/**
 * Helper programático para verificar un feature sin middleware.
 */
async function hasFeature(workspace, featureName) {
  try {
    const { allowed } = await resolveFeature(featureName, workspace);
    return allowed;
  } catch {
    return false;
  }
}

/**
 * Obtener el valor específico de un feature (ej: 'basic' vs 'full' para analytics).
 */
async function getFeatureValue(workspace, featureName) {
  try {
    const { allowed, value } = await resolveFeature(featureName, workspace);
    return allowed ? value : null;
  } catch {
    return null;
  }
}

/**
 * Devuelve el mapa completo de features resueltos para un workspace.
 * Útil para incluir en respuestas de API o calcular visibilidad en frontend.
 */
async function getWorkspaceFeatures(workspace) {
  const result = {};
  for (const [shortName, canonicalKey] of Object.entries(FEATURE_NAME_MAP)) {
    try {
      const { allowed, value } = await resolveFeature(shortName, workspace);
      result[canonicalKey] = allowed ? (value === true ? true : value) : false;
    } catch {
      result[canonicalKey] = false;
    }
  }
  return result;
}

module.exports = {
  checkFeature,
  checkAnyFeature,
  hasFeature,
  getFeatureValue,
  getWorkspaceFeatures,
  resolveFeature,
  FEATURE_NAME_MAP,
  PLAN_FEATURE_DEFAULTS,
};
