// Seed complete plan configs + transcoding config into system_config
// Fixes:
//  - Adds maxHeight per plan (used by transcoder to limit qualities)
//  - Adds transcodingQualities for enterprise custom selection
//  - Adds global transcoding config with all quality presets enabled
const db = require('../db');

db.init().then(async () => {
  const now = Math.floor(Date.now() / 1000);

  // 1. Global transcoding config — all qualities allowed globally
  // Each plan then limits via maxHeight
  await db.pool.query(
    `INSERT INTO system_config (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ['transcoding', JSON.stringify({
      qualities: ['360p', '480p', '720p', '1080p', '1440p', '4k'],
      defaultQualities: ['360p', '480p', '720p', '1080p'],
    }), now]
  );
  console.log('OK transcoding config');

  // 2. Update the 'plans' key (used by routes/plans.js for the public API)
  // This includes maxHeight so the transcoder knows quality limits per plan
  const plansConfig = {
    starter: {
      name: 'Starter',
      description: 'Para creadores que comienzan',
      price: 0,
      badge: null,
      maxVideos: 50,
      maxStorageGB: 20,
      maxBandwidthGB: 100,
      maxFileSizeMB: 10240,
      maxWorkspaces: 1,
      maxMembers: 3,
      maxHeight: 720, // transcoder limit: max 720p
      features: {
        foldersEnabled: true,
        playlistsEnabled: true,
        webhooksEnabled: false,
        transcriptionsEnabled: false,
        downloadLinksEnabled: false,
        watermarkEnabled: false,
        analyticsEnabled: 'basic',
        embedEnabled: 'branded',
        adsEnabled: true,
        bulkOperationsEnabled: false,
        apiKeysEnabled: false,
        tracksEnabled: true,
        invitationsEnabled: true,
        referralEnabled: true,
        multiWorkspaceEnabled: false,
        customDomainEnabled: false,
        adblockDetection: false,
      },
    },
    pro: {
      name: 'Pro',
      description: 'Para creadores profesionales',
      price: 29,
      badge: 'Popular',
      highlighted: true,
      maxVideos: 500,
      maxStorageGB: 100,
      maxBandwidthGB: 1000,
      maxFileSizeMB: 20480,
      maxWorkspaces: 3,
      maxMembers: 10,
      maxHeight: 1080, // transcoder limit: max 1080p
      features: {
        foldersEnabled: true,
        playlistsEnabled: true,
        webhooksEnabled: true,
        transcriptionsEnabled: true,
        downloadLinksEnabled: true,
        watermarkEnabled: true,
        analyticsEnabled: 'full',
        embedEnabled: 'unbranded',
        adsEnabled: true,
        bulkOperationsEnabled: true,
        apiKeysEnabled: true,
        tracksEnabled: true,
        invitationsEnabled: true,
        referralEnabled: true,
        multiWorkspaceEnabled: true,
        customDomainEnabled: false,
        adblockDetection: true,
      },
    },
    enterprise: {
      name: 'Enterprise',
      description: 'Para empresas y equipos grandes',
      price: 99,
      badge: null,
      maxVideos: -1,
      maxStorageGB: -1,
      maxBandwidthGB: -1,
      maxFileSizeMB: 102400,
      maxWorkspaces: -1,
      maxMembers: -1,
      maxHeight: 2160, // transcoder limit: up to 4K
      features: {
        foldersEnabled: true,
        playlistsEnabled: true,
        webhooksEnabled: true,
        transcriptionsEnabled: true,
        downloadLinksEnabled: true,
        watermarkEnabled: true,
        analyticsEnabled: 'full',
        embedEnabled: 'custom',
        adsEnabled: true,
        bulkOperationsEnabled: true,
        apiKeysEnabled: true,
        tracksEnabled: true,
        invitationsEnabled: true,
        referralEnabled: true,
        multiWorkspaceEnabled: true,
        customDomainEnabled: true,
        adblockDetection: true,
      },
    },
  };

  await db.pool.query(
    `INSERT INTO system_config (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ['plans', JSON.stringify(plansConfig), now]
  );
  console.log('OK plans (with maxHeight)');

  // 3. Verify all config keys
  const r = await db.pool.query(`SELECT key FROM system_config ORDER BY key`);
  console.log('\nAll system_config keys:', r.rows.map(x => x.key).join(', '));

  process.exit(0);
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
