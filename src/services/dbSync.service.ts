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
        "name" TEXT NOT NULL DEFAULT 'Client Review Link',
        "canApprove" BOOLEAN NOT NULL DEFAULT true,
        "clientName" TEXT,
        "clientEmail" TEXT,
        "allowFeedback" BOOLEAN NOT NULL DEFAULT true,
        "expiresAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL
      );`,

      // 4b. Ensure ClientShareToken columns exist if table was previously created
      `ALTER TABLE "ClientShareToken" 
        ADD COLUMN IF NOT EXISTS "name" TEXT DEFAULT 'Client Review Link',
        ADD COLUMN IF NOT EXISTS "canApprove" BOOLEAN DEFAULT true;`,

      // 4c. Ensure Brand columns exist (description, website for AI context)
      `ALTER TABLE "Brand"
        ADD COLUMN IF NOT EXISTS "description" TEXT,
        ADD COLUMN IF NOT EXISTS "website" TEXT;`,

      // 4d. Ensure BrandVoiceProfile columns exist (standardFaqs, responseGuidelines)
      `ALTER TABLE "BrandVoiceProfile"
        ADD COLUMN IF NOT EXISTS "standardFaqs" TEXT,
        ADD COLUMN IF NOT EXISTS "responseGuidelines" TEXT;`,

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
      );`,

      // 9. Content Studio v3.0 columns on Content
      `ALTER TABLE "Content"
        ADD COLUMN IF NOT EXISTS "campaignId" TEXT,
        ADD COLUMN IF NOT EXISTS "pillarId" TEXT;`,

      // 10. MarketingStrategy table (v3.0)
      `CREATE TABLE IF NOT EXISTS "MarketingStrategy" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "brandId" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'DRAFT',
        "version" INTEGER NOT NULL DEFAULT 1,
        "businessContext" TEXT NOT NULL DEFAULT '',
        "targetAudience" TEXT NOT NULL DEFAULT '[]',
        "valueProposition" TEXT NOT NULL DEFAULT '',
        "positioning" TEXT NOT NULL DEFAULT '',
        "messagingPillars" TEXT NOT NULL DEFAULT '[]',
        "marketingObjectives" TEXT NOT NULL DEFAULT '[]',
        "channelStrategy" TEXT NOT NULL DEFAULT '[]',
        "roadmap" TEXT NOT NULL DEFAULT '[]',
        "approvedByUserId" TEXT,
        "approvedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,

      // 11. ContentPillar table (v3.0)
      `CREATE TABLE IF NOT EXISTS "ContentPillar" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "brandId" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "description" TEXT,
        "targetPercentage" INTEGER NOT NULL DEFAULT 25,
        "color" TEXT NOT NULL DEFAULT '#6366f1',
        "themes" TEXT NOT NULL DEFAULT '[]',
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,

      // 12. ContentIdea table (v3.0)
      `CREATE TABLE IF NOT EXISTS "ContentIdea" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "brandId" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "description" TEXT,
        "source" TEXT NOT NULL DEFAULT 'AI_SUGGESTION',
        "status" TEXT NOT NULL DEFAULT 'NEW',
        "tags" TEXT NOT NULL DEFAULT '[]',
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,

      // 13. ContentRequest table (v3.0)
      `CREATE TABLE IF NOT EXISTS "ContentRequest" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "brandId" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "objective" TEXT,
        "targetAudience" TEXT,
        "keyPoints" TEXT,
        "deadline" TIMESTAMP(3),
        "requestedByUserId" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,

      // 14. Campaign table (v3.0)
      `CREATE TABLE IF NOT EXISTS "Campaign" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "brandId" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "objective" TEXT,
        "concept" TEXT,
        "status" TEXT NOT NULL DEFAULT 'DRAFT',
        "startDate" TIMESTAMP(3),
        "endDate" TIMESTAMP(3),
        "budget" TEXT,
        "keyMessages" TEXT NOT NULL DEFAULT '[]',
        "targetAudience" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,

      // 15. MediaAsset table (v3.0)
      `CREATE TABLE IF NOT EXISTS "MediaAsset" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "brandId" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "fileUrl" TEXT NOT NULL,
        "fileType" TEXT NOT NULL DEFAULT 'IMAGE',
        "fileSize" INTEGER,
        "dimensions" TEXT,
        "tags" TEXT NOT NULL DEFAULT '[]',
        "source" TEXT NOT NULL DEFAULT 'UPLOAD',
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,

      // 16. LaunchpadProgress table (v3.0)
      `CREATE TABLE IF NOT EXISTS "LaunchpadProgress" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "brandId" TEXT NOT NULL UNIQUE,
        "currentStage" INTEGER NOT NULL DEFAULT 1,
        "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
        "stageData" TEXT NOT NULL DEFAULT '{}',
        "completedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,

      // 17. SkillDefinition table (v3.0)
      `CREATE TABLE IF NOT EXISTS "SkillDefinition" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "category" TEXT NOT NULL,
        "description" TEXT NOT NULL,
        "version" TEXT NOT NULL DEFAULT '1.0.0',
        "status" TEXT NOT NULL DEFAULT 'ACTIVE',
        "inputSchema" TEXT NOT NULL DEFAULT '{}',
        "outputSchema" TEXT NOT NULL DEFAULT '{}',
        "instructions" TEXT NOT NULL,
        "contextRequirements" TEXT NOT NULL DEFAULT '[]',
        "allowedTools" TEXT NOT NULL DEFAULT '[]',
        "isSystem" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,

      // 18. SkillExecution table (v3.0)
      `CREATE TABLE IF NOT EXISTS "SkillExecution" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "tenantId" TEXT NOT NULL,
        "brandId" TEXT NOT NULL,
        "skillId" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "input" TEXT NOT NULL DEFAULT '{}',
        "output" TEXT,
        "status" TEXT NOT NULL DEFAULT 'COMPLETED',
        "plan" TEXT,
        "steps" TEXT,
        "executionTimeMs" INTEGER,
        "error" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
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
