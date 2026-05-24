// Seed plan configurations into system_config
// Run: docker exec streamvault-api-1 node scripts/seed-plans.js
const db = require('../db');

db.init().then(async () => {
  const now = Math.floor(Date.now() / 1000);

  const plans = {
    'plans.starter': {
      name: 'Starter',
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
      limits: { maxVideos: 50, maxStorageGB: 10, maxBandwidthGB: 100 },
    },
    'plans.pro': {
      name: 'Pro',
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
      limits: { maxVideos: 500, maxStorageGB: 100, maxBandwidthGB: 1000 },
    },
    'plans.enterprise': {
      name: 'Enterprise',
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
      limits: { maxVideos: -1, maxStorageGB: -1, maxBandwidthGB: -1 },
    },
  };

  for (const [key, value] of Object.entries(plans)) {
    await db.pool.query(
      `INSERT INTO system_config (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value), now]
    );
    console.log('OK', key);
  }

  // Verify
  const r = await db.pool.query(`SELECT key FROM system_config WHERE key LIKE 'plans.%' OR key = 'features'`);
  console.log('\nAll config entries:', r.rows.map(x => x.key));

  process.exit(0);
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
