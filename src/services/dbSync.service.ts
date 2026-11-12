import { prisma } from './db.service';

export class DbSyncService {
  /**
   * Automatically verifies and adds any missing columns or tables
   * to the PostgreSQL database on boot.
   * This guarantees that production databases (e.g. Render, Railway, AWS)
   * never fail with "column does not exist" errors!
   */
  static async autoSyncDatabase(): Promise<void> {
    try {
      console.log('🔄 [DbSync] Verifying database schema columns...');

      // 1. Content table columns (Feature 1B: firstComment, Feature 1C: viralityScore, Feature 4A: evergreen, Feature 3A: client approval)
      await prisma.$executeRawUnsafe(`
        DO $$ 
        BEGIN 
          BEGIN
            ALTER TABLE "Content" ADD COLUMN "firstComment" TEXT;
          EXCEPTION WHEN duplicate_column THEN END;

          BEGIN
            ALTER TABLE "Content" ADD COLUMN "viralityScore" INTEGER;
          EXCEPTION WHEN duplicate_column THEN END;

          BEGIN
            ALTER TABLE "Content" ADD COLUMN "isEvergreen" BOOLEAN DEFAULT false;
          EXCEPTION WHEN duplicate_column THEN END;

          BEGIN
            ALTER TABLE "Content" ADD COLUMN "recycleIntervalDays" INTEGER DEFAULT 60;
          EXCEPTION WHEN duplicate_column THEN END;

          BEGIN
            ALTER TABLE "Content" ADD COLUMN "lastRecycledAt" TIMESTAMP(3);
          EXCEPTION WHEN duplicate_column THEN END;

          BEGIN
            ALTER TABLE "Content" ADD COLUMN "clientApprovalStatus" TEXT DEFAULT 'PENDING';
          EXCEPTION WHEN duplicate_column THEN END;

          BEGIN
            ALTER TABLE "Content" ADD COLUMN "clientFeedback" TEXT;
          EXCEPTION WHEN duplicate_column THEN END;
        END $$;
      `);

      // 2. Tenant table columns (BYOK & AI Provider settings)
      await prisma.$executeRawUnsafe(`
        DO $$ 
        BEGIN 
          BEGIN
            ALTER TABLE "Tenant" ADD COLUMN "customMetaAppId" TEXT;
          EXCEPTION WHEN duplicate_column THEN END;

          BEGIN
            ALTER TABLE "Tenant" ADD COLUMN "customMetaAppSecret" TEXT;
          EXCEPTION WHEN duplicate_column THEN END;

          BEGIN
            ALTER TABLE "Tenant" ADD COLUMN "customAiApiKey" TEXT;
          EXCEPTION WHEN duplicate_column THEN END;

          BEGIN
            ALTER TABLE "Tenant" ADD COLUMN "customAiProvider" TEXT DEFAULT 'GEMINI';
          EXCEPTION WHEN duplicate_column THEN END;
        END $$;
      `);

      // 3. Ensure LeadFunnel table exists (Feature 2A: Comment-to-DM)
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "LeadFunnel" (
          "id" TEXT NOT NULL,
          "brandId" TEXT NOT NULL,
          "keyword" TEXT NOT NULL,
          "leadMagnetUrl" TEXT NOT NULL,
          "dmMessageTemplate" TEXT NOT NULL,
          "publicReplyTemplate" TEXT NOT NULL,
          "isActive" BOOLEAN NOT NULL DEFAULT true,
          "collectedLeadsCount" INTEGER NOT NULL DEFAULT 0,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL,
          CONSTRAINT "LeadFunnel_pkey" PRIMARY KEY ("id")
        );
      `);

      // 4. Ensure ClientShareToken table exists (Feature 3A: Client Approval Portal)
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "ClientShareToken" (
          "id" TEXT NOT NULL,
          "brandId" TEXT NOT NULL,
          "token" TEXT NOT NULL,
          "clientName" TEXT,
          "clientEmail" TEXT,
          "allowFeedback" BOOLEAN NOT NULL DEFAULT true,
          "expiresAt" TIMESTAMP(3),
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL,
          CONSTRAINT "ClientShareToken_pkey" PRIMARY KEY ("id")
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "ClientShareToken_token_key" ON "ClientShareToken"("token");
      `);

      // 5. Ensure OAuthState table exists
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "OAuthState" (
          "id" TEXT NOT NULL,
          "state" TEXT NOT NULL,
          "platform" TEXT NOT NULL,
          "tenantId" TEXT NOT NULL,
          "brandId" TEXT NOT NULL,
          "expiresAt" TIMESTAMP(3) NOT NULL,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL,
          CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("id")
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "OAuthState_state_key" ON "OAuthState"("state");
      `);

      // 6. Ensure TeamInvitation table exists
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "TeamInvitation" (
          "id" TEXT NOT NULL,
          "tenantId" TEXT NOT NULL,
          "email" TEXT NOT NULL,
          "role" TEXT NOT NULL DEFAULT 'TEAM_MEMBER',
          "token" TEXT NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'PENDING',
          "invitedByUserId" TEXT NOT NULL,
          "expiresAt" TIMESTAMP(3) NOT NULL,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL,
          CONSTRAINT "TeamInvitation_pkey" PRIMARY KEY ("id")
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "TeamInvitation_token_key" ON "TeamInvitation"("token");
      `);

      // 7. Ensure AnalyticsMetric table exists
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "AnalyticsMetric" (
          "id" TEXT NOT NULL,
          "tenantId" TEXT NOT NULL,
          "brandId" TEXT,
          "platform" TEXT NOT NULL,
          "metricType" TEXT NOT NULL,
          "metricValue" DOUBLE PRECISION NOT NULL,
          "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "AnalyticsMetric_pkey" PRIMARY KEY ("id")
        );
      `);

      // 8. Ensure AiUsageLog table exists
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "AiUsageLog" (
          "id" TEXT NOT NULL,
          "tenantId" TEXT NOT NULL,
          "userId" TEXT NOT NULL,
          "action" TEXT NOT NULL,
          "tokensUsed" INTEGER NOT NULL DEFAULT 0,
          "costEstimate" DOUBLE PRECISION NOT NULL DEFAULT 0,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "AiUsageLog_pkey" PRIMARY KEY ("id")
        );
      `);

      console.log('✅ [DbSync] Database schema columns & tables verified successfully!');
    } catch (err: any) {
      console.warn('⚠️ [DbSync] Schema verification note:', err.message);
    }
  }
}
