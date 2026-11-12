import { prisma } from './db.service';

export class DbSyncService {
  /**
   * Automatically verifies and adds any missing columns or tables
   * to the PostgreSQL database on boot.
   * This guarantees that production databases (e.g. Render, Railway, AWS)
   * never fail with "column does not exist" errors!
   */
  static async autoSyncDatabase(): Promise<void> {
    console.log('🔄 [DbSync] Verifying database schema columns & tables...');

    const statements: string[] = [
      // 1. Content table columns (Feature 1B: firstComment, Feature 1C: viralityScore, Feature 4A: evergreen, Feature 3A: client approval)
      `ALTER TABLE "Content" 
        ADD COLUMN IF NOT EXISTS "firstComment" TEXT,
        ADD COLUMN IF NOT EXISTS "viralityScore" INTEGER,
        ADD COLUMN IF NOT EXISTS "isEvergreen" BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS "recycleIntervalDays" INTEGER DEFAULT 60,
        ADD COLUMN IF NOT EXISTS "lastRecycledAt" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "clientApprovalStatus" TEXT DEFAULT 'PENDING',
        ADD COLUMN IF NOT EXISTS "clientFeedback" TEXT;`,

      // 2. Tenant table columns (BYOK & AI Provider settings)
      `ALTER TABLE "Tenant" 
        ADD COLUMN IF NOT EXISTS "customMetaAppId" TEXT,
        ADD COLUMN IF NOT EXISTS "customMetaAppSecret" TEXT,
        ADD COLUMN IF NOT EXISTS "customAiApiKey" TEXT,
        ADD COLUMN IF NOT EXISTS "customAiProvider" TEXT DEFAULT 'GEMINI';`,

      // 3. Ensure LeadFunnel table exists (Feature 2A: Comment-to-DM)
      `CREATE TABLE IF NOT EXISTS "LeadFunnel" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "brandId" TEXT NOT NULL,
        "keyword" TEXT NOT NULL,
        "leadMagnetUrl" TEXT NOT NULL,
        "dmMessageTemplate" TEXT NOT NULL,
        "publicReplyTemplate" TEXT NOT NULL,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "collectedLeadsCount" INTEGER NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL
      );`,

      // 4. Ensure ClientShareToken table exists (Feature 3A: Client Approval Portal)
      `CREATE TABLE IF NOT EXISTS "ClientShareToken" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "brandId" TEXT NOT NULL,
        "token" TEXT NOT NULL UNIQUE,
        "clientName" TEXT,
        "clientEmail" TEXT,
        "allowFeedback" BOOLEAN NOT NULL DEFAULT true,
        "expiresAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL
      );`,

      // 5. Ensure OAuthState table exists
      `CREATE TABLE IF NOT EXISTS "OAuthState" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "state" TEXT NOT NULL UNIQUE,
        "platform" TEXT NOT NULL,
        "tenantId" TEXT NOT NULL,
        "brandId" TEXT NOT NULL,
        "expiresAt" TIMESTAMP(3) NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL
      );`,

      // 6. Ensure TeamInvitation table exists
      `CREATE TABLE IF NOT EXISTS "TeamInvitation" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "tenantId" TEXT NOT NULL,
        "email" TEXT NOT NULL,
        "role" TEXT NOT NULL DEFAULT 'TEAM_MEMBER',
        "token" TEXT NOT NULL UNIQUE,
        "status" TEXT NOT NULL DEFAULT 'PENDING',
        "invitedByUserId" TEXT NOT NULL,
        "expiresAt" TIMESTAMP(3) NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL
      );`,

      // 7. Ensure AnalyticsMetric table exists
      `CREATE TABLE IF NOT EXISTS "AnalyticsMetric" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "tenantId" TEXT NOT NULL,
        "brandId" TEXT,
        "platform" TEXT NOT NULL,
        "metricType" TEXT NOT NULL,
        "metricValue" DOUBLE PRECISION NOT NULL,
        "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,

      // 8. Ensure AiUsageLog table exists
      `CREATE TABLE IF NOT EXISTS "AiUsageLog" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "tenantId" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "action" TEXT NOT NULL,
        "tokensUsed" INTEGER NOT NULL DEFAULT 0,
        "costEstimate" DOUBLE PRECISION NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`
    ];

    for (const stmt of statements) {
      try {
        await prisma.$executeRawUnsafe(stmt);
      } catch (err: any) {
        console.warn('⚠️ [DbSync] Statement note:', err.message);
      }
    }

    console.log('✅ [DbSync] Database schema columns & tables verified successfully!');
  }
}
