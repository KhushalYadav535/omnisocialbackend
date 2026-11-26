import { Router, Response } from 'express';
import { prisma } from '../services/db.service';
import { authenticateToken, requireTenant, AuthRequest } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/rbac.middleware';
import { MetaService } from '../services/meta.service';
import { CryptoService } from '../services/crypto.service';
import { ClientReportService } from '../services/clientReport.service';

const router = Router();

router.use(authenticateToken);
router.use(requireTenant);

// =====================================================================
// 1. Advanced Analytics Dashboard (Real Data & Aggregations)
// =====================================================================
router.get('/dashboard', requirePermission('VIEW_ANALYTICS'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { brandId, socialAccountId, platform, startDate, endDate, format } = req.query;

    const tenantId = req.user?.tenantId!;

    // Resolve tenant brands
    const brandFilter: any = {
      business: {
        tenantId
      }
    };

    if (brandId && typeof brandId === 'string') {
      brandFilter.id = brandId;
    }

    const tenantBrands = await prisma.brand.findMany({
      where: brandFilter,
      select: { id: true, name: true }
    });
    const brandIds = tenantBrands.map(b => b.id);

    if (brandIds.length === 0) {
      res.json({
        kpis: {
          totalPublishedPosts: 0,
          totalQueuedPosts: 0,
          totalFailedPosts: 0,
          totalInteractions: 0,
          unreadCount: 0,
          needsResponseCount: 0,
          engagementRate: 0,
          engagementRateFormula: 'Average interactions per published post: (Total Interactions / Total Published Posts)',
          activeBrandsCount: 0,
          connectedAccountsCount: 0
        },
        sentimentStats: { positive: 0, neutral: 0, negative: 0 },
        platformDistribution: { facebook: 0, instagram: 0 },
        dailyTrends: [],
        bestPerformingPosts: [],
        metaInsights: {
          status: 'UNAVAILABLE',
          reason: 'No brands configured for this organization'
        }
      });
      return;
    }

    // Date range boundaries
    const now = new Date();
    const parsedStart = startDate ? new Date(String(startDate)) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const parsedEnd = endDate ? new Date(String(endDate)) : now;

    // Build Publication Query Filter
    const pubWhere: any = {
      content: {
        brandId: { in: brandIds },
        clientApprovalStatus: { notIn: ['REJECTED', 'PENDING'] },
        status: { not: 'DRAFT' }
      }
    };

    if (socialAccountId && typeof socialAccountId === 'string') {
      pubWhere.socialAccountId = socialAccountId;
    }

    if (platform && typeof platform === 'string' && platform.toUpperCase() !== 'ALL') {
      pubWhere.socialAccount = { platform: platform.toUpperCase() };
    }

    if (format && typeof format === 'string' && format.toUpperCase() !== 'ALL') {
      pubWhere.content.format = format.toUpperCase();
    }

    // Build Interaction Query Filter
    const interactionWhere: any = {
      brandId: { in: brandIds },
      createdAt: { gte: parsedStart, lte: parsedEnd }
    };

    if (socialAccountId && typeof socialAccountId === 'string') {
      interactionWhere.socialAccountId = socialAccountId;
    }

    if (platform && typeof platform === 'string' && platform.toUpperCase() !== 'ALL') {
      interactionWhere.platform = platform.toUpperCase();
    }

    // Parallel Database Aggregations
    const [
      publishedPostsCount,
      queuedPostsCount,
      failedPostsCount,
      missedPostsCount,
      totalInteractions,
      unreadInteractions,
      needsResponseInteractions,
      fbInteractions,
      igInteractions,
      connectedAccountsCount,
      classifications,
      recentPublishedPubs,
      interactionsByDate,
      accounts
    ] = await Promise.all([
      // 1. Published posts in window
      prisma.publication.count({
        where: {
          ...pubWhere,
          status: 'PUBLISHED',
          publishedAt: { gte: parsedStart, lte: parsedEnd }
        }
      }),
      // 2. Active upcoming queued posts (exclude past-due drops counted as missed)
      prisma.publication.count({
        where: {
          ...pubWhere,
          status: 'QUEUED',
          OR: [
            { scheduledFor: null },
            { scheduledFor: { gte: now } }
          ]
        }
      }),
      // 3. Failed posts in window (deduplicated by distinct contentId to match calendar)
      prisma.publication.findMany({
        where: {
          ...pubWhere,
          status: 'FAILED',
          updatedAt: { gte: parsedStart, lte: parsedEnd }
        },
        select: { contentId: true }
      }).then(pubs => new Set(pubs.map(p => p.contentId)).size),
      // 3B. Missed or overdue queued drops matching Calendar status semantics
      prisma.publication.count({
        where: {
          ...pubWhere,
          OR: [
            { status: 'MISSED' },
            {
              status: 'QUEUED',
              scheduledFor: { lt: now }
            }
          ]
        }
      }),
      // 4. Total interactions
      prisma.interaction.count({ where: interactionWhere }),
      // 5. Unread interactions
      prisma.interaction.count({ where: { ...interactionWhere, isRead: false } }),
      // 6. Needs response
      prisma.interaction.count({
        where: {
          ...interactionWhere,
          replyStatus: { in: ['NEEDS_RESPONSE', 'DRAFT_READY'] }
        }
      }),
      // 7. Facebook interactions
      prisma.interaction.count({
        where: { ...interactionWhere, platform: 'FACEBOOK' }
      }),
      // 8. Instagram interactions
      prisma.interaction.count({
        where: { ...interactionWhere, platform: 'INSTAGRAM' }
      }),
      // 9. Connected accounts count
      prisma.socialAccount.count({
        where: { brandId: { in: brandIds }, isConnected: true }
      }),
      // 10. Classifications for sentiment
      prisma.classification.findMany({
        where: { interaction: interactionWhere },
        select: { sentiment: true }
      }),
      // 11. Top Published Publications with details
      prisma.publication.findMany({
        where: {
          ...pubWhere,
          status: 'PUBLISHED',
          publishedAt: { gte: parsedStart, lte: parsedEnd }
        },
        include: {
          content: {
            select: { id: true, title: true, caption: true, format: true, mediaUrls: true }
          },
          socialAccount: {
            select: { id: true, accountName: true, platform: true }
          }
        },
        orderBy: { publishedAt: 'desc' },
        take: 10
      }),
      // 12. Interactions by Date for Real Daily Trends
      prisma.interaction.findMany({
        where: interactionWhere,
        select: { createdAt: true, platform: true }
      }),
      // 13. Social accounts to check for Meta Graph Insights eligibility
      prisma.socialAccount.findMany({
        where: { brandId: { in: brandIds }, isConnected: true, platform: 'FACEBOOK' },
        take: 1
      })
    ]);

    // Sentiment breakdown
    const positive = classifications.filter(c => c.sentiment === 'POSITIVE').length;
    const neutral = classifications.filter(c => c.sentiment === 'NEUTRAL').length;
    const negative = classifications.filter(c => c.sentiment === 'NEGATIVE').length;
    const totalClassified = classifications.length || 1;

    const sentimentStats = {
      positive: Math.round((positive / totalClassified) * 100),
      neutral: Math.round((neutral / totalClassified) * 100),
      negative: Math.round((negative / totalClassified) * 100)
    };

    // Calculate genuine engagement rate: (total interactions / total published posts)
    const engagementRate = publishedPostsCount > 0
      ? Number((totalInteractions / publishedPostsCount).toFixed(2))
      : 0;

    // Aggregate real daily trends by date bucket (YYYY-MM-DD)
    const trendMap: Record<string, { date: string; interactions: number; publications: number }> = {};

    // Initialize last 7 days buckets
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      trendMap[key] = { date: key, interactions: 0, publications: 0 };
    }

    // Populate actual interaction counts
    interactionsByDate.forEach(item => {
      const key = item.createdAt.toISOString().split('T')[0];
      if (trendMap[key]) {
        trendMap[key].interactions++;
      }
    });

    // Populate actual publication counts
    recentPublishedPubs.forEach(pub => {
      if (pub.publishedAt) {
        const key = pub.publishedAt.toISOString().split('T')[0];
        if (trendMap[key]) {
          trendMap[key].publications++;
        }
      }
    });

    const dailyTrends = Object.values(trendMap).sort((a, b) => a.date.localeCompare(b.date));

    // Best-performing content
    const bestPerformingPosts = recentPublishedPubs.map(pub => {
      let mediaUrls: string[] = [];
      try {
        mediaUrls = JSON.parse(pub.content?.mediaUrls || '[]');
      } catch {
        mediaUrls = [];
      }

      return {
        id: pub.id,
        title: pub.content?.title || 'Social Post',
        caption: pub.content?.caption,
        format: pub.content?.format,
        mediaUrl: mediaUrls[0] || null,
        platform: pub.socialAccount?.platform,
        accountName: pub.socialAccount?.accountName,
        publishedAt: pub.publishedAt,
        postUrl: pub.platformPostUrl
      };
    });

    // Deduplicate posts by title + platform so all published channel drops are represented
    const uniqueBestPerformingPosts = bestPerformingPosts.filter((p, i, arr) =>
      i === arr.findIndex(item => `${item.title?.trim().toLowerCase()}_${item.platform}` === `${p.title?.trim().toLowerCase()}_${p.platform}`)
    );

    // Meta Graph API Insights Check
    let metaInsights: any = {
      status: 'UNAVAILABLE',
      reason: 'No connected Facebook or Instagram accounts for external reach retrieval'
    };

    if (accounts.length > 0) {
      const acc = accounts[0];
      try {
        const rawToken = CryptoService.isEncrypted(acc.accessToken)
          ? CryptoService.decrypt(acc.accessToken)
          : acc.accessToken;
        metaInsights = await MetaService.getPageInsights(acc.platformAccountId, rawToken);
      } catch (metaErr: any) {
        const rawMsg = metaErr.message || '';
        let cleanReason = 'Live external reach telemetry requires verified Meta Business App read_insights approval.';
        if (rawMsg.includes('#100') || rawMsg.includes('valid insights metric')) {
          cleanReason = 'Meta Graph API v26.0 external metric permissions pending Meta App Review. Internal database telemetry is active.';
        } else if (rawMsg.includes('#190') || rawMsg.includes('OAuthException')) {
          cleanReason = 'Page token expired or invalid. Reconnect account in Channels settings to resume external metrics.';
        } else if (rawMsg.includes('#200')) {
          cleanReason = 'Page permissions required: account needs administrator insights access.';
        }
        metaInsights = {
          status: 'UNAVAILABLE',
          reason: cleanReason
        };
      }
    }

    res.json({
      dateRange: {
        startDate: parsedStart.toISOString(),
        endDate: parsedEnd.toISOString()
      },
      kpis: {
        totalPublishedPosts: publishedPostsCount,
        totalQueuedPosts: queuedPostsCount,
        totalFailedPosts: failedPostsCount,
        totalMissedPosts: missedPostsCount,
        totalUnfulfilledDrops: failedPostsCount + missedPostsCount,
        publishingSla: (publishedPostsCount + failedPostsCount + missedPostsCount) > 0
          ? Math.round((publishedPostsCount / (publishedPostsCount + failedPostsCount + missedPostsCount)) * 100)
          : 100,
        totalInteractions,
        unreadCount: unreadInteractions,
        needsResponseCount: needsResponseInteractions,
        engagementRate,
        engagementRateFormula: 'Average interactions per published post: (Total Interactions / Total Published Posts)',
        activeBrandsCount: brandIds.length,
        connectedAccountsCount
      },
      sentimentStats,
      platformDistribution: {
        facebook: fbInteractions,
        instagram: igInteractions
      },
      dailyTrends,
      bestPerformingPosts: uniqueBestPerformingPosts,
      metaInsights
    });
  } catch (err: any) {
    console.error('Advanced dashboard analytics error:', err);
    res.status(500).json({ error: err.message || 'Failed to retrieve analytics dashboard' });
  }
});

// =====================================================================
// 2. Historical Analytics Snapshot & Synchronization (Idempotent)
// =====================================================================
router.post('/sync', requirePermission('VIEW_ANALYTICS'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { brandId } = req.body;
    const tenantId = req.user?.tenantId!;

    const brand = await prisma.brand.findFirst({
      where: {
        id: brandId,
        business: { tenantId }
      }
    });

    if (!brand) {
      res.status(404).json({ error: 'Brand not found or not owned by your organization' });
      return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [publishedCount, interactionCount] = await Promise.all([
      prisma.publication.count({
        where: {
          content: { brandId: brand.id },
          status: 'PUBLISHED',
          publishedAt: { gte: today }
        }
      }),
      prisma.interaction.count({
        where: {
          brandId: brand.id,
          createdAt: { gte: today }
        }
      })
    ]);

    // Idempotent sync: update if exists for this brand & date, create otherwise
    const existingPub = await prisma.analyticsMetric.findFirst({
      where: {
        tenantId,
        brandId: brand.id,
        metricName: 'PUBLICATIONS_COUNT',
        measuredAt: today
      }
    });

    if (existingPub) {
      await prisma.analyticsMetric.update({
        where: { id: existingPub.id },
        data: { metricValue: publishedCount }
      });
    } else {
      await prisma.analyticsMetric.create({
        data: {
          tenantId,
          brandId: brand.id,
          socialAccountId: null,
          platform: 'PLATFORM_AGGREGATE',
          metricName: 'PUBLICATIONS_COUNT',
          metricValue: publishedCount,
          measuredAt: today,
          sourceApi: 'POSTGRESQL_AGGREGATED',
          syncStatus: 'AVAILABLE'
        }
      });
    }

    const existingInteractions = await prisma.analyticsMetric.findFirst({
      where: {
        tenantId,
        brandId: brand.id,
        metricName: 'INTERACTIONS_COUNT',
        measuredAt: today
      }
    });

    if (existingInteractions) {
      await prisma.analyticsMetric.update({
        where: { id: existingInteractions.id },
        data: { metricValue: interactionCount }
      });
    } else {
      await prisma.analyticsMetric.create({
        data: {
          tenantId,
          brandId: brand.id,
          socialAccountId: null,
          platform: 'PLATFORM_AGGREGATE',
          metricName: 'INTERACTIONS_COUNT',
          metricValue: interactionCount,
          measuredAt: today,
          sourceApi: 'POSTGRESQL_AGGREGATED',
          syncStatus: 'AVAILABLE'
        }
      });
    }

    const syncedMetricsCount = 2;

    res.json({
      success: true,
      message: 'Historical analytics metrics synchronized idempotently',
      syncedMetricsCount,
      measuredAt: today.toISOString()
    });
  } catch (err: any) {
    console.error('Analytics sync error:', err);
    res.status(500).json({ error: err.message || 'Failed to synchronize analytics' });
  }
});

// =====================================================================
// 3. Export Analytics Report to CSV (RFC 4180 Compliant)
// =====================================================================
router.get('/export', requirePermission('EXPORT_DATA'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { brandId, startDate, endDate, platform } = req.query;
    const tenantId = req.user?.tenantId!;

    const brandFilter: any = {
      business: { tenantId }
    };
    if (brandId && typeof brandId === 'string') {
      brandFilter.id = brandId;
    }

    const tenantBrands = await prisma.brand.findMany({
      where: brandFilter,
      select: { id: true, name: true }
    });
    const brandIds = tenantBrands.map(b => b.id);

    const parsedStart = startDate ? new Date(String(startDate)) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const parsedEnd = endDate ? new Date(String(endDate)) : new Date();

    const pubWhere: any = {
      content: { brandId: { in: brandIds } },
      createdAt: { gte: parsedStart, lte: parsedEnd }
    };

    if (platform && typeof platform === 'string' && platform.toUpperCase() !== 'ALL') {
      pubWhere.socialAccount = { platform: platform.toUpperCase() };
    }

    const publications = await prisma.publication.findMany({
      where: pubWhere,
      include: {
        content: {
          select: { title: true, format: true, brand: { select: { name: true } } }
        },
        socialAccount: {
          select: { platform: true, accountName: true }
        }
      },
      orderBy: { scheduledFor: 'desc' }
    });

    // Build RFC 4180 CSV
    const escapeCsv = (str: any) => {
      if (str === null || str === undefined) return '""';
      const s = String(str).replace(/"/g, '""');
      return `"${s}"`;
    };

    const headers = [
      'Publication ID',
      'Brand Name',
      'Platform',
      'Account Name',
      'Post Title',
      'Format',
      'Status',
      'Scheduled For',
      'Published At',
      'Platform Post ID'
    ];

    const rows = publications.map(p => [
      escapeCsv(p.id),
      escapeCsv(p.content?.brand?.name || 'Unassigned'),
      escapeCsv(p.socialAccount?.platform || 'FACEBOOK'),
      escapeCsv(p.socialAccount?.accountName || 'Unnamed'),
      escapeCsv(p.content?.title || 'Social Post'),
      escapeCsv(p.content?.format || 'POST'),
      escapeCsv(p.status),
      escapeCsv(p.scheduledFor?.toISOString()),
      escapeCsv(p.publishedAt?.toISOString() || 'N/A'),
      escapeCsv(p.platformPostId || 'N/A')
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(r => r.join(','))
    ].join('\r\n');

    const filename = `analytics-report-${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(csvContent);
  } catch (err: any) {
    console.error('Analytics CSV export error:', err);
    res.status(500).json({ error: err.message || 'Failed to export analytics CSV' });
  }
});

// Feature 3B: 1-Click Executive AI Client Performance Report (PDF Export)
router.get('/client-report-pdf', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    let { brandId, period = 'month', download } = req.query;

    if (!brandId || typeof brandId !== 'string') {
      const fallbackBrand = await prisma.brand.findFirst({
        where: req.user?.tenantId ? { business: { tenantId: req.user.tenantId } } : undefined
      });
      brandId = fallbackBrand?.id;
    }

    if (!brandId || typeof brandId !== 'string') {
      res.status(400).json({ error: 'brandId query parameter is required' });
      return;
    }

    const host = req.get('host') || 'localhost:5000';
    let protocol = req.protocol || 'http';
    if (host.includes('onrender.com') || req.headers['x-forwarded-proto'] === 'https') {
      protocol = 'https';
    }

    const report = await ClientReportService.generateClientReportPdf(
      brandId,
      req.user?.tenantId!,
      host,
      protocol,
      period as 'week' | 'month'
    );

    if (download === 'true' && report.pdfPath) {
      res.download(report.pdfPath, report.filename);
      return;
    }

    res.json({
      success: true,
      report
    });
  } catch (err: any) {
    console.error('Client report PDF generation error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate client report PDF' });
  }
});

// Feature 3C: POST /client-report and POST /client-report-pdf (N8 Report Builder PDF Export)
const handlePostClientReport = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    let { brandId, days, period } = req.body || {};

    if (!brandId) {
      const fallbackBrand = await prisma.brand.findFirst({
        where: req.user?.tenantId ? { business: { tenantId: req.user.tenantId } } : undefined
      });
      brandId = fallbackBrand?.id;
    }

    if (!brandId) {
      res.status(400).json({ error: 'brandId is required to generate client report' });
      return;
    }

    const calcPeriod: 'week' | 'month' = period || (Number(days) <= 7 ? 'week' : 'month');

    const host = req.get('host') || 'localhost:5000';
    let protocol = req.protocol || 'http';
    if (host.includes('onrender.com') || req.headers['x-forwarded-proto'] === 'https') {
      protocol = 'https';
    }

    const report = await ClientReportService.generateClientReportPdf(
      brandId,
      req.user?.tenantId!,
      host,
      protocol,
      calcPeriod
    );

    res.json({
      success: true,
      report
    });
  } catch (err: any) {
    console.error('Client report generation error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate client report' });
  }
};

router.post('/client-report', handlePostClientReport);
router.post('/client-report-pdf', handlePostClientReport);

export default router;
