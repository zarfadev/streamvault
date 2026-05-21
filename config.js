/**
 * Centralized configuration loader.
 * Reads .env via dotenv and exports a frozen config object.
 * All other modules import from here instead of process.env directly.
 */
require('dotenv').config();
const crypto = require('crypto');

// FIX #17: Enforce strong JWT secrets - minimum 64 characters always
function autoSecret(envVar, label) {
  const val = process.env[envVar];
  const MIN_LENGTH = 64; // Increased from 32 to 64 for stronger security
  
  const isPlaceholder = !val ||
    val === 'change-me-to-random-64-chars' ||
    val === 'change-me-to-different-random-64-chars' ||
    val.length < MIN_LENGTH;
  
  if (!isPlaceholder) {
    return val;
  }
  
  if (process.env.NODE_ENV === 'production') {
    console.error(`❌ ${label} (${envVar}) is required in production and must be at least ${MIN_LENGTH} characters. Set it in .env`);
    process.exit(1);
  }
  
  // Generate 64-character secret for development
  const generated = crypto.randomBytes(32).toString('hex'); // 64 hex chars
  console.warn(`⚠️  ${label} not set or too short — auto-generated for development (first 8 chars: ${generated.slice(0, 8)}...)`);
  console.warn(`⚠️  Minimum required length: ${MIN_LENGTH} characters`);
  return generated;
}

const config = Object.freeze({
  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') !== 'production',
  appUrl: process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`,

  // Auth
  jwtSecret: autoSecret('JWT_SECRET', 'JWT Secret'),
  jwtRefreshSecret: autoSecret('JWT_REFRESH_SECRET', 'JWT Refresh Secret'),
  jwtAccessExpiry: '15m',
  jwtRefreshExpiry: '7d',
  jwtRefreshExpiryMs: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
  // Increased from 12 to 14 for better security (trade-off: ~2x slower hashing)
  bcryptRounds: 14,

  // reCAPTCHA v3 (optional — skip validation when not configured)
  recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || '',
  recaptchaSecretKey: process.env.RECAPTCHA_SECRET_KEY || '',

  // Admin (API key for automation, or use JWT with platform_role=super_admin)
  adminApiKey: process.env.ADMIN_API_KEY || '',

  // Super admin bootstrap: email to promote to platform_role=super_admin (see db.js)
  superAdminEmail: process.env.SUPER_ADMIN_EMAIL || '',

  // Redis (Bull queue for transcoding)
  redisUrl: process.env.REDIS_URL || '',

  // AWS S3 + CloudFront (optional; use IAM role on EC2)
  awsRegion: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
  s3Bucket: process.env.S3_BUCKET || '',
  s3KeyPrefix: (process.env.S3_KEY_PREFIX || 'media').replace(/^\/+|\/+$/g, ''),
  /** Base URL for HLS (CloudFront or S3 website); no trailing slash */
  cdnBaseUrl: (process.env.CLOUDFRONT_BASE_URL || process.env.S3_CDN_BASE || '').replace(/\/+$/, ''),
  /** CloudFront distribution ID — needed for cache invalidation on video delete/update */
  cloudfrontDistributionId: process.env.CLOUDFRONT_DISTRIBUTION_ID || '',

  // AWS Bedrock (AI content analysis — optional, requires IAM bedrock:InvokeModel permission)
  bedrockModelId: process.env.BEDROCK_MODEL_ID || 'claude-haiku-4-5-20251001',

  // Email
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
  },

  // Stripe
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    prices: {
      starter: process.env.STRIPE_PRICE_STARTER || '',
      pro: process.env.STRIPE_PRICE_PRO || '',
      enterprise: process.env.STRIPE_PRICE_ENTERPRISE || '',
    },
  },

  // dLocal Go (LATAM — tarjetas, transferencias, vouchers)
  // Credenciales: Dashboard → Integrations → API Integration
  // Planes:       Dashboard → Integrations → Subscriptions → Plans
  dlocalgo: {
    apiKey:    process.env.DLOCALGO_API_KEY    || '',
    secretKey: process.env.DLOCALGO_SECRET_KEY || '',
    mode:      process.env.DLOCALGO_MODE       || 'sandbox', // 'sandbox' | 'production'
    plans: {
      starter:    process.env.DLOCALGO_PLAN_STARTER    || '',
      pro:        process.env.DLOCALGO_PLAN_PRO        || '',
      enterprise: process.env.DLOCALGO_PLAN_ENTERPRISE || '',
    },
  },

  // Binance Pay (crypto — USDT/BTC, renovación automática cada 30 días)
  // Credenciales: Binance Merchant → https://merchant.binance.com
  // BINANCE_MODE: 'live' | 'sandbox'
  binance: {
    apiKey:     process.env.BINANCE_API_KEY      || '',
    secretKey:  process.env.BINANCE_SECRET_KEY   || '',
    merchantId: process.env.BINANCE_MERCHANT_ID  || '',
    mode:       process.env.BINANCE_MODE         || 'sandbox',
    prices: {
      starter:    parseFloat(process.env.BINANCE_PRICE_STARTER    || '9.99'),
      pro:        parseFloat(process.env.BINANCE_PRICE_PRO        || '29.99'),
      enterprise: parseFloat(process.env.BINANCE_PRICE_ENTERPRISE || '99.99'),
    },
  },

  // Plan limits
  plans: {
    starter: {
      name: 'Starter',
      price: 19,
      maxVideos: 25,
      maxStorageGB: 50,
      maxBandwidthGB: 100,
      embed: 'branded',
      analytics: 'basic',
      subtitles: false,
      apiAccess: false,
    },
    pro: {
      name: 'Pro',
      price: 59,
      maxVideos: 200,
      maxStorageGB: 500,
      maxBandwidthGB: 1000,
      embed: 'unbranded',
      analytics: 'full',
      subtitles: true,
      apiAccess: true,
    },
    enterprise: {
      name: 'Enterprise',
      price: 99,
      maxVideos: -1, // unlimited
      maxStorageGB: 2000,
      maxBandwidthGB: 5000,
      embed: 'custom',
      analytics: 'full',
      subtitles: true,
      apiAccess: true,
    },
  },
});

module.exports = config;
