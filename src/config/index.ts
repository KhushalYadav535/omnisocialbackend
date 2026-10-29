import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '5000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/social_media_db?schema=public',
  jwtSecret: process.env.JWT_SECRET || 'super_secret_social_media_mgmt_jwt_key_2026_xyz',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  meta: {
    appId: process.env.META_APP_ID || 'meta_app_id_preview',
    appSecret: process.env.META_APP_SECRET || 'meta_app_secret_preview_sec_2026',
    redirectUri: process.env.META_REDIRECT_URI || 'http://localhost:3000/accounts/callback',
    apiVersion: process.env.META_GRAPH_API_VERSION || 'v26.0',
    graphBaseUrl: `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION || 'v26.0'}`,
    webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || 'social_media_secure_verify_token_2026',
    tokenEncryptionKey: process.env.META_TOKEN_ENCRYPTION_KEY || '9f3c8a1b4e6d2f5a7c0e8b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a'
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || process.env.AI_API_KEY || '',
    baseUrl: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    defaultModel: process.env.OPENROUTER_DEFAULT_MODEL || 'openai/gpt-4o-mini',
    replyModel: process.env.OPENROUTER_REPLY_MODEL || process.env.OPENROUTER_DEFAULT_MODEL || 'openai/gpt-4o-mini',
    contentModel: process.env.OPENROUTER_CONTENT_MODEL || process.env.OPENROUTER_DEFAULT_MODEL || 'openai/gpt-4o-mini',
    classificationModel: process.env.OPENROUTER_CLASSIFICATION_MODEL || process.env.OPENROUTER_DEFAULT_MODEL || 'openai/gpt-4o-mini',
    fallbackModel: process.env.OPENROUTER_FALLBACK_MODEL || 'meta-llama/llama-3.3-70b-instruct',
    timeoutMs: parseInt(process.env.OPENROUTER_TIMEOUT_MS || '30000', 10)
  },
  ai: {
    apiKey: process.env.OPENROUTER_API_KEY || process.env.AI_API_KEY || '',
    defaultProvider: 'OPENROUTER'
  },
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000'
};

export default config;
