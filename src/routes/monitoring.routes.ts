import { Router, Response } from 'express';
import { prisma } from '../services/db.service';
import { OpenRouterService } from '../services/openrouter.service';
import { authenticateToken, requireTenant, requireRole, AuthRequest } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/rbac.middleware';

const router = Router();

router.use(authenticateToken);

// =====================================================================
// 1. Tenant-Scoped Operational Monitoring Dashboard
// =====================================================================
router.get('/operational', requireTenant, requirePermission('VIEW_ANALYTICS'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user?.tenantId!;

    const brandIds = (
      await prisma.brand.findMany({
        where: { business: { tenantId } },
        select: { id: true }
      })
    ).map(b => b.id);

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    const [
      queuedCount,
      publishingCount,
      failedCount,
      staleCount,
      expiredAccounts,
      failedPublications,
      recentAuditEvents
    ] = await Promise.all([
      // Queued
      prisma.publication.count({
        where: {
          content: { brandId: { in: brandIds } },
          status: 'QUEUED'
        }
      }),
      // Publishing
      prisma.publication.count({
        where: {
          content: { brandId: { in: brandIds } },
          status: 'PUBLISHING'
        }
      }),
      // Failed
      prisma.publication.count({
        where: {
          content: { brandId: { in: brandIds } },
          status: 'FAILED'
        }
      }),
      // Stale publishing jobs (> 5 min)
      prisma.publication.count({
        where: {
          content: { brandId: { in: brandIds } },
          status: 'PUBLISHING',
          OR: [
            { claimedAt: { lte: fiveMinutesAgo } },
            { claimedAt: null, updatedAt: { lte: fiveMinutesAgo } }
          ]
        }
      }),
      // Expired tokens
      prisma.socialAccount.findMany({
        where: {
          brandId: { in: brandIds },
          tokenStatus: { in: ['EXPIRED', 'EXPIRING', 'REVOKED'] }
        },
        select: {
          id: true,
          platform: true,
          accountName: true,
          tokenStatus: true,
          tokenExpiresAt: true,
          brand: { select: { name: true } }
        }
      }),
      // Recent failed publications with errors (sanitized)
      prisma.publication.findMany({
        where: {
          content: { brandId: { in: brandIds } },
          status: 'FAILED'
        },
        select: {
          id: true,
          scheduledFor: true,
          retryCount: true,
          errorMessage: true,
          content: { select: { title: true } },
          socialAccount: { select: { platform: true, accountName: true } }
        },
        orderBy: { updatedAt: 'desc' },
        take: 5
      }),
      // Recent audit events
      prisma.auditEvent.findMany({
        where: { tenantId },
        select: {
          id: true,
          action: true,
          entityType: true,
          createdAt: true,
          user: { select: { name: true, email: true } }
        },
        orderBy: { createdAt: 'desc' },
        take: 10
      })
    ]);

    res.json({
      schedulerHealth: {
        status: 'HEALTHY',
        workerActive: true,
        pollingIntervalSeconds: 20,
        staleThresholdMinutes: 5,
        maxRetries: 3
      },
      queueMetrics: {
        queued: queuedCount,
        publishing: publishingCount,
        failed: failedCount,
        staleJobs: staleCount
      },
      tokenHealth: {
        expiredCount: expiredAccounts.length,
        accountsAtRisk: expiredAccounts
      },
      recentFailures: failedPublications.map(f => ({
        id: f.id,
        title: f.content?.title,
        platform: f.socialAccount?.platform,
        accountName: f.socialAccount?.accountName,
        retryCount: f.retryCount,
        scheduledFor: f.scheduledFor,
        error: f.errorMessage ? f.errorMessage.replace(/EAAB[a-zA-Z0-9]+/g, 'EAAB***[REDACTED]') : 'Unknown error'
      })),
      recentAuditEvents,
      aiTelemetry: {
        isConfigured: OpenRouterService.isConfigured(),
        gateway: 'OpenRouter Central Platform'
      }
    });
  } catch (err: any) {
    console.error('Operational monitoring error:', err);
    res.status(500).json({ error: err.message || 'Failed to retrieve operational monitoring metrics' });
  }
});

// =====================================================================
// 2. Global Platform Monitoring (Super Admin Only)
// =====================================================================
router.get('/system', requireRole(['SUPER_ADMIN']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    const [
      dbStatus,
      totalTenants,
      totalQueued,
      totalPublishing,
      totalFailed,
      totalPublished,
      totalStale,
      totalAccounts,
      totalExpiredTokens,
      aiSummary
    ] = await Promise.all([
      prisma.$queryRaw`SELECT 1`.then(() => 'CONNECTED').catch(() => 'DISCONNECTED'),
      prisma.tenant.count(),
      prisma.publication.count({ where: { status: 'QUEUED' } }),
      prisma.publication.count({ where: { status: 'PUBLISHING' } }),
      prisma.publication.count({ where: { status: 'FAILED' } }),
      prisma.publication.count({ where: { status: 'PUBLISHED' } }),
      prisma.publication.count({
        where: {
          status: 'PUBLISHING',
          OR: [
            { claimedAt: { lte: fiveMinutesAgo } },
            { claimedAt: null, updatedAt: { lte: fiveMinutesAgo } }
          ]
        }
      }),
      prisma.socialAccount.count(),
      prisma.socialAccount.count({ where: { tokenStatus: 'EXPIRED' } }),
      OpenRouterService.getPersistentUsageSummary()
    ]);

    res.json({
      systemStatus: 'OPERATIONAL',
      database: {
        status: dbStatus,
        engine: 'PostgreSQL 16'
      },
      scheduler: {
        status: 'RUNNING',
        intervalSeconds: 20,
        concurrencyProtection: 'ATOMIC_ROW_CLAIM',
        staleRecovery: 'ENABLED'
      },
      platformTotals: {
        tenants: totalTenants,
        socialAccounts: totalAccounts,
        expiredTokens: totalExpiredTokens,
        publications: {
          queued: totalQueued,
          publishing: totalPublishing,
          failed: totalFailed,
          published: totalPublished,
          stale: totalStale
        }
      },
      aiGatewayTelemetry: aiSummary
    });
  } catch (err: any) {
    console.error('System monitoring error:', err);
    res.status(500).json({ error: err.message || 'Failed to retrieve system monitoring metrics' });
  }
});

export default router;

