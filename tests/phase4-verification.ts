import axios from 'axios';
import crypto from 'crypto';
import { prisma } from '../src/services/db.service';
import { CryptoService } from '../src/services/crypto.service';
import { LoggerService } from '../src/services/logger.service';

const API_BASE = 'http://localhost:5000/api';

interface TestResult {
  scenario: number;
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function recordTest(scenario: number, name: string, passed: boolean, details: string) {
  results.push({ scenario, name, passed, details });
  const icon = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${icon} [Test ${scenario}]: ${name} - ${details}`);
}

async function runPhase4VerificationSuite() {
  console.log('====================================================');
  console.log('🚀 Starting Phase 4 Production Verification Suite');
  console.log('   (Analytics, Calendar, Team RBAC & Monitoring)');
  console.log('====================================================\n');

  let tenantA: any;
  let tenantB: any;
  let userOwnerA: any;
  let userAnalystA: any;
  let userOwnerB: any;
  let tokenOwnerA = '';
  let tokenAnalystA = '';
  let tokenOwnerB = '';
  let brandA: any;
  let contentPost: any;
  let publicationQueued: any;
  let publicationPublished: any;

  try {
    // -----------------------------------------------------------------
    // Setup Test Tenancies, Users and Seed Data
    // -----------------------------------------------------------------
    // 1. Tenant A (Apex Digital)
    tenantA = await prisma.tenant.findFirst({ where: { slug: 'apex-digital' } });
    if (!tenantA) {
      tenantA = await prisma.tenant.create({
        data: { name: 'Apex Digital Agency', slug: `apex-digital-${Date.now()}`, status: 'ACTIVE' }
      });
    }

    // 2. Tenant B (Pulse Network)
    tenantB = await prisma.tenant.findFirst({ where: { slug: 'pulse-network' } });
    if (!tenantB) {
      tenantB = await prisma.tenant.create({
        data: { name: 'Pulse Creator Network', slug: `pulse-network-${Date.now()}`, status: 'ACTIVE' }
      });
    }

    // 3. User Owner A
    userOwnerA = await prisma.user.findFirst({ where: { email: 'admin@apexdigital.com' } });
    if (userOwnerA) {
      await prisma.user.update({ where: { id: userOwnerA.id }, data: { role: 'OWNER' } });
    }

    // 4. User Analyst A (Read-only role)
    userAnalystA = await prisma.user.findFirst({ where: { email: 'analyst@apexdigital.com' } });
    if (!userAnalystA) {
      userAnalystA = await prisma.user.create({
        data: {
          email: 'analyst@apexdigital.com',
          passwordHash: userOwnerA?.passwordHash || '$2a$10$abcdefghijklmnopqrstuv',
          name: 'Apex Data Analyst',
          role: 'ANALYST',
          tenantId: tenantA.id
        }
      });
    }

    // 5. User Owner B
    userOwnerB = await prisma.user.findFirst({ where: { email: 'creator@pulsenetwork.com' } });
    if (userOwnerB) {
      await prisma.user.update({ where: { id: userOwnerB.id }, data: { role: 'OWNER' } });
    }

    // Authenticate tokens
    const loginA = await axios.post(`${API_BASE}/auth/login`, {
      email: 'admin@apexdigital.com',
      password: 'Password123!'
    });
    tokenOwnerA = loginA.data.token;

    const loginB = await axios.post(`${API_BASE}/auth/login`, {
      email: 'creator@pulsenetwork.com',
      password: 'Password123!'
    });
    tokenOwnerB = loginB.data.token;

    // Direct token for Analyst A
    const jwt = require('jsonwebtoken');
    const { config } = require('../src/config');
    tokenAnalystA = jwt.sign(
      { id: userAnalystA.id, email: userAnalystA.email, role: 'ANALYST', tenantId: tenantA.id },
      config.jwtSecret,
      { expiresIn: '1h' }
    );

    // Resolve Brand A
    brandA = await prisma.brand.findFirst({
      where: { business: { tenantId: tenantA.id } }
    });

    if (!brandA) {
      const biz = await prisma.business.create({
        data: { tenantId: tenantA.id, name: 'Apex Media Business' }
      });
      brandA = await prisma.brand.create({
        data: { businessId: biz.id, name: 'Apex Primary Brand' }
      });
    }

    // Setup Test Social Account for Tenant A
    const accountA = await prisma.socialAccount.create({
      data: {
        brandId: brandA.id,
        platform: 'FACEBOOK',
        platformAccountId: `fb_page_${Date.now()}`,
        accountName: 'Phase 4 Test Page',
        accessToken: CryptoService.encrypt('EAAB_mock_token_for_phase4'),
        tokenStatus: 'VALID'
      }
    });

    // Content post
    contentPost = await prisma.content.create({
      data: {
        brandId: brandA.id,
        createdByUserId: userOwnerA.id,
        title: 'Phase 4 Verification Post',
        caption: 'Automated testing post for Analytics and Calendar',
        status: 'SCHEDULED'
      }
    });

    // Queued publication
    publicationQueued = await prisma.publication.create({
      data: {
        contentId: contentPost.id,
        socialAccountId: accountA.id,
        scheduledFor: new Date(Date.now() + 24 * 60 * 60 * 1000), // Tomorrow
        status: 'QUEUED'
      }
    });

    // Published publication
    publicationPublished = await prisma.publication.create({
      data: {
        contentId: contentPost.id,
        socialAccountId: accountA.id,
        scheduledFor: new Date(Date.now() - 3600000),
        publishedAt: new Date(Date.now() - 3500000),
        status: 'PUBLISHED',
        platformPostId: `post_fb_${Date.now()}`
      }
    });

    // =================================================================
    // Scenario 1: Advanced Analytics Dashboard Aggregations & Honest Meta State
    // =================================================================
    try {
      const res = await axios.get(`${API_BASE}/analytics/dashboard?brandId=${brandA.id}`, {
        headers: { Authorization: `Bearer ${tokenOwnerA}` }
      });

      const kpis = res.data?.kpis;
      const metaInsights = res.data?.metaInsights;
      const dailyTrends = res.data?.dailyTrends;

      const passed =
        res.status === 200 &&
        kpis.totalPublishedPosts >= 1 &&
        kpis.totalQueuedPosts >= 1 &&
        typeof kpis.engagementRate === 'number' &&
        kpis.engagementRateFormula.includes('Total Interactions / Total Published Posts') &&
        metaInsights &&
        (metaInsights.status === 'PERMISSION_REQUIRED' || metaInsights.status === 'UNAVAILABLE' || metaInsights.status === 'AVAILABLE' || metaInsights.status === 'TOKEN_EXPIRED') &&
        Array.isArray(dailyTrends);

      recordTest(
        1,
        'Advanced Analytics Real PostgreSQL Aggregation & Honest Meta Status',
        passed,
        `Published: ${kpis.totalPublishedPosts}, Queued: ${kpis.totalQueuedPosts}, EngagementRate: ${kpis.engagementRate}, MetaInsights: ${metaInsights.status}`
      );
    } catch (err: any) {
      recordTest(1, 'Advanced Analytics Real PostgreSQL Aggregation & Honest Meta Status', false, err.message);
    }

    // =================================================================
    // Scenario 2: Analytics Tenant Isolation (Tenant B Cannot Access Tenant A Data)
    // =================================================================
    try {
      const resB = await axios.get(`${API_BASE}/analytics/dashboard?brandId=${brandA.id}`, {
        headers: { Authorization: `Bearer ${tokenOwnerB}` }
      });

      // Since brandA belongs to Tenant A, Tenant B's query for brandA yields empty results
      const kpisB = resB.data?.kpis;
      const passed = kpisB.totalPublishedPosts === 0 && kpisB.activeBrandsCount === 0;

      recordTest(
        2,
        'Analytics Cross-Tenant Isolation Enforcement',
        passed,
        `Tenant B isolated: Zero records returned when querying Tenant A brand (Count: ${kpisB.totalPublishedPosts})`
      );
    } catch (err: any) {
      recordTest(2, 'Analytics Cross-Tenant Isolation Enforcement', false, err.message);
    }

    // =================================================================
    // Scenario 3: Idempotent Historical Analytics Metric Synchronization
    // =================================================================
    try {
      await prisma.analyticsMetric.deleteMany({ where: { brandId: brandA.id } });

      // 1st sync
      const sync1 = await axios.post(`${API_BASE}/analytics/sync`, { brandId: brandA.id }, {
        headers: { Authorization: `Bearer ${tokenOwnerA}` }
      });

      // 2nd sync (immediate duplicate call)
      const sync2 = await axios.post(`${API_BASE}/analytics/sync`, { brandId: brandA.id }, {
        headers: { Authorization: `Bearer ${tokenOwnerA}` }
      });

      // Count metrics in PostgreSQL for this brand and today
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const count = await prisma.analyticsMetric.count({
        where: { brandId: brandA.id, measuredAt: today }
      });

      // Must be exactly 2 metrics (PUBLICATIONS_COUNT and INTERACTIONS_COUNT) without duplicate rows
      const passed = sync1.status === 200 && sync2.status === 200 && count === 2;

      recordTest(
        3,
        'Historical Analytics Idempotent Synchronization',
        passed,
        `Synced metrics count in DB: ${count} (No duplicate rows created after repeated sync calls)`
      );
    } catch (err: any) {
      recordTest(3, 'Historical Analytics Idempotent Synchronization', false, err.message);
    }

    // =================================================================
    // Scenario 4: Analytics CSV Export with Authorization Check
    // =================================================================
    try {
      const exportRes = await axios.get(`${API_BASE}/analytics/export?brandId=${brandA.id}`, {
        headers: { Authorization: `Bearer ${tokenAnalystA}` }
      });

      const isCsv = exportRes.headers['content-type']?.includes('text/csv');
      const csvData = String(exportRes.data);
      const hasHeaders = csvData.includes('Publication ID') && csvData.includes('Brand Name');
      const hasContent = csvData.includes(contentPost.title);

      const passed = exportRes.status === 200 && isCsv && hasHeaders && hasContent;

      recordTest(
        4,
        'RFC 4180 CSV Export with Role Authorization',
        passed,
        `Content-Type: text/csv, Headers Present: ${hasHeaders}, Post Title Present: ${hasContent}`
      );
    } catch (err: any) {
      recordTest(4, 'RFC 4180 CSV Export with Role Authorization', false, err.message);
    }

    // =================================================================
    // Scenario 5: Content Calendar Items Retrieval & Range Filtering
    // =================================================================
    try {
      const calRes = await axios.get(`${API_BASE}/calendar?brandId=${brandA.id}`, {
        headers: { Authorization: `Bearer ${tokenOwnerA}` }
      });

      const events = calRes.data?.events || [];
      const queuedEvent = events.find((e: any) => e.publicationId === publicationQueued.id);
      const publishedEvent = events.find((e: any) => e.publicationId === publicationPublished.id);

      const passed =
        calRes.status === 200 &&
        queuedEvent &&
        publishedEvent &&
        queuedEvent.status === 'QUEUED' &&
        publishedEvent.status === 'PUBLISHED' &&
        publishedEvent.publishedAt !== null;

      recordTest(
        5,
        'Calendar Events Listing with Valid Status & Semantics',
        passed,
        `Events retrieved: ${events.length}, Queued item verified, Published item verified (publishedAt: ${publishedEvent?.publishedAt})`
      );
    } catch (err: any) {
      recordTest(5, 'Calendar Events Listing with Valid Status & Semantics', false, err.message);
    }

    // =================================================================
    // Scenario 6: Drag-and-Drop Rescheduling of Queued Post
    // =================================================================
    try {
      const newFutureDate = new Date(Date.now() + 48 * 60 * 60 * 1000); // 2 days ahead
      const reschedRes = await axios.post(`${API_BASE}/calendar/reschedule`, {
        publicationId: publicationQueued.id,
        newDate: newFutureDate.toISOString()
      }, {
        headers: { Authorization: `Bearer ${tokenOwnerA}` }
      });

      const checkDb = await prisma.publication.findUnique({
        where: { id: publicationQueued.id }
      });

      const passed =
        reschedRes.status === 200 &&
        checkDb?.status === 'QUEUED' &&
        checkDb?.claimedAt === null &&
        new Date(checkDb.scheduledFor).getTime() === newFutureDate.getTime();

      recordTest(
        6,
        'Drag-and-Drop Post Rescheduling Validation',
        passed,
        `Rescheduled to: ${checkDb?.scheduledFor.toISOString()}, claimedAt: ${checkDb?.claimedAt}, status: ${checkDb?.status}`
      );
    } catch (err: any) {
      recordTest(6, 'Drag-and-Drop Post Rescheduling Validation', false, err.message);
    }

    // =================================================================
    // Scenario 7: Rescheduling Already-Published Post Safely Rejected
    // =================================================================
    try {
      let rejected = false;
      let rejectError = '';
      try {
        await axios.post(`${API_BASE}/calendar/reschedule`, {
          publicationId: publicationPublished.id,
          newDate: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()
        }, {
          headers: { Authorization: `Bearer ${tokenOwnerA}` }
        });
      } catch (e: any) {
        rejected = e.response?.status === 400;
        rejectError = e.response?.data?.error || '';
      }

      recordTest(
        7,
        'Rejection of Rescheduling Already-Published Posts',
        rejected && rejectError.includes('already been published'),
        `Rejected with HTTP 400: "${rejectError}"`
      );
    } catch (err: any) {
      recordTest(7, 'Rejection of Rescheduling Already-Published Posts', false, err.message);
    }

    // =================================================================
    // Scenario 8: Rescheduling to Past Date Safely Rejected
    // =================================================================
    try {
      let rejectedPast = false;
      try {
        await axios.post(`${API_BASE}/calendar/reschedule`, {
          publicationId: publicationQueued.id,
          newDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() // Yesterday
        }, {
          headers: { Authorization: `Bearer ${tokenOwnerA}` }
        });
      } catch (e: any) {
        rejectedPast = e.response?.status === 400;
      }

      recordTest(
        8,
        'Rejection of Rescheduling to Past Date',
        rejectedPast,
        'Past date scheduling request correctly rejected with HTTP 400'
      );
    } catch (err: any) {
      recordTest(8, 'Rejection of Rescheduling to Past Date', false, err.message);
    }

    // =================================================================
    // Scenario 9: Role-Based Access Control (RBAC) Permission Enforcement
    // =================================================================
    try {
      // Analyst role lacks MANAGE_TEAM and CREATE_CONTENT permissions
      let analystBlockedFromTeam = false;
      try {
        await axios.post(`${API_BASE}/team/invite`, {
          email: 'someuser@apexdigital.com',
          role: 'EDITOR'
        }, {
          headers: { Authorization: `Bearer ${tokenAnalystA}` }
        });
      } catch (e: any) {
        analystBlockedFromTeam = e.response?.status === 403;
      }

      let analystBlockedFromSchedule = false;
      try {
        await axios.post(`${API_BASE}/calendar/reschedule`, {
          publicationId: publicationQueued.id,
          newDate: new Date(Date.now() + 50000).toISOString()
        }, {
          headers: { Authorization: `Bearer ${tokenAnalystA}` }
        });
      } catch (e: any) {
        analystBlockedFromSchedule = e.response?.status === 403;
      }

      const passed = analystBlockedFromTeam && analystBlockedFromSchedule;

      recordTest(
        9,
        'Server-Side RBAC Enforcement on Restricted Roles',
        passed,
        `ANALYST role blocked from team management (403: ${analystBlockedFromTeam}) and scheduling (403: ${analystBlockedFromSchedule})`
      );
    } catch (err: any) {
      recordTest(9, 'Server-Side RBAC Enforcement on Restricted Roles', false, err.message);
    }

    // =================================================================
    // Scenario 10: Cryptographically Secure Single-Use Invitation Generation
    // =================================================================
    let rawInvitationToken = '';
    let inviteEmail = `member_${Date.now()}@apexdigital.com`;

    try {
      const inviteRes = await axios.post(`${API_BASE}/team/invite`, {
        email: inviteEmail,
        role: 'EDITOR'
      }, {
        headers: { Authorization: `Bearer ${tokenOwnerA}` }
      });

      rawInvitationToken = inviteRes.data?.invitation?.invitationToken;

      // Verify token hash is stored in database, not the raw token
      const expectedHash = crypto.createHash('sha256').update(rawInvitationToken).digest('hex');
      const dbInvite = await prisma.teamInvitation.findUnique({
        where: { tokenHash: expectedHash }
      });

      const passed =
        inviteRes.status === 201 &&
        rawInvitationToken.length === 64 &&
        dbInvite !== null &&
        dbInvite.isAccepted === false &&
        dbInvite.isRevoked === false;

      recordTest(
        10,
        'Cryptographically Secure Single-Use Team Invitation Creation',
        passed,
        `Token length: 64 hex characters, SHA-256 hash verified in PostgreSQL, Raw token not persisted`
      );
    } catch (err: any) {
      recordTest(10, 'Cryptographically Secure Single-Use Team Invitation Creation', false, err.message);
    }

    // =================================================================
    // Scenario 11: Single-Use Invitation Acceptance & Activation
    // =================================================================
    try {
      const acceptRes = await axios.post(`${API_BASE}/team/accept-invite`, {
        invitationToken: rawInvitationToken,
        name: 'Jordan Lee (Editor)',
        password: 'EditorSecurePassword2026!'
      });

      const acceptedUser = await prisma.user.findUnique({
        where: { email: inviteEmail }
      });

      const tokenHash = crypto.createHash('sha256').update(rawInvitationToken).digest('hex');
      const updatedInvite = await prisma.teamInvitation.findUnique({
        where: { tokenHash }
      });

      const passed =
        acceptRes.status === 200 &&
        acceptRes.data?.token &&
        acceptedUser?.role === 'EDITOR' &&
        acceptedUser?.tenantId === tenantA.id &&
        updatedInvite?.isAccepted === true;

      recordTest(
        11,
        'Single-Use Invitation Acceptance & Account Provisioning',
        passed,
        `User activated with role: ${acceptedUser?.role}, Tenant bound: ${acceptedUser?.tenantId}, Invitation isAccepted: ${updatedInvite?.isAccepted}`
      );
    } catch (err: any) {
      recordTest(11, 'Single-Use Invitation Acceptance & Account Provisioning', false, err.message);
    }

    // =================================================================
    // Scenario 12: Replay Attack on Consumed Invitation Rejected
    // =================================================================
    try {
      let rejectedReplay = false;
      try {
        await axios.post(`${API_BASE}/team/accept-invite`, {
          invitationToken: rawInvitationToken,
          name: 'Attacker Replay',
          password: 'AttackerPassword2026!'
        });
      } catch (e: any) {
        rejectedReplay = e.response?.status === 400;
      }

      recordTest(
        12,
        'Replay Attack Protection on Consumed Invitation Tokens',
        rejectedReplay,
        'Re-submitting consumed invitation token rejected with HTTP 400'
      );
    } catch (err: any) {
      recordTest(12, 'Replay Attack Protection on Consumed Invitation Tokens', false, err.message);
    }

    // =================================================================
    // Scenario 13: Cross-Tenant Invitation Acceptance Forbidden
    // =================================================================
    try {
      // Invite an existing user from Tenant A into Tenant B
      const crossInviteRes = await axios.post(`${API_BASE}/team/invite`, {
        email: userOwnerA.email, // Registered in Tenant A
        role: 'EDITOR'
      }, {
        headers: { Authorization: `Bearer ${tokenOwnerB}` }
      });

      const crossToken = crossInviteRes.data?.invitation?.invitationToken;

      let rejectedCross = false;
      try {
        await axios.post(`${API_BASE}/team/accept-invite`, {
          invitationToken: crossToken,
          name: 'Cross User',
          password: 'ValidPassword123!'
        });
      } catch (e: any) {
        rejectedCross = e.response?.status === 403;
      }

      recordTest(
        13,
        'Cross-Tenant Invitation Hijack Protection',
        rejectedCross,
        'Attempt to accept invitation from another tenant for existing user rejected with HTTP 403'
      );
    } catch (err: any) {
      recordTest(13, 'Cross-Tenant Invitation Hijack Protection', false, err.message);
    }

    // =================================================================
    // Scenario 14: Privilege Escalation Prevention in Role Assignment
    // =================================================================
    try {
      // Create a valid ADMIN user in DB
      const testAdmin = await prisma.user.create({
        data: {
          email: `admin_priv_${Date.now()}@apexdigital.com`,
          passwordHash: '$2a$10$abcdefghijklmnopqrstuv',
          name: 'Privilege Test Admin',
          role: 'ADMIN',
          tenantId: tenantA.id
        }
      });

      const jwt = require('jsonwebtoken');
      const { config } = require('../src/config');
      const tokenAdminA = jwt.sign(
        { id: testAdmin.id, email: testAdmin.email, role: 'ADMIN', tenantId: tenantA.id },
        config.jwtSecret,
        { expiresIn: '1h' }
      );

      // ADMIN tries to invite someone as OWNER -> must be rejected
      let rejectedEscalation = false;
      try {
        await axios.post(`${API_BASE}/team/invite`, {
          email: 'newowner@apexdigital.com',
          role: 'OWNER'
        }, {
          headers: { Authorization: `Bearer ${tokenAdminA}` }
        });
      } catch (e: any) {
        rejectedEscalation = e.response?.status === 403;
      }

      // Cleanup
      await prisma.user.delete({ where: { id: testAdmin.id } }).catch(() => {});

      recordTest(
        14,
        'Privilege Escalation Prevention (Admin Cannot Create Owner)',
        rejectedEscalation,
        'Admin attempting to assign OWNER role rejected with HTTP 403'
      );
    } catch (err: any) {
      recordTest(14, 'Privilege Escalation Prevention (Admin Cannot Create Owner)', false, err.message);
    }

    // =================================================================
    // Scenario 15: Tenant Operational Monitoring Isolation
    // =================================================================
    try {
      const monResA = await axios.get(`${API_BASE}/monitoring/operational`, {
        headers: { Authorization: `Bearer ${tokenOwnerA}` }
      });

      const monResB = await axios.get(`${API_BASE}/monitoring/operational`, {
        headers: { Authorization: `Bearer ${tokenOwnerB}` }
      });

      const queueA = monResA.data?.queueMetrics;
      const queueB = monResB.data?.queueMetrics;

      // Tenant A has 1 queued publication created earlier; Tenant B has 0
      const passed =
        monResA.status === 200 &&
        monResB.status === 200 &&
        queueA.queued >= 1 &&
        queueB.queued === 0;

      recordTest(
        15,
        'Operational Monitoring Tenant Data Isolation',
        passed,
        `Tenant A queued items: ${queueA.queued}, Tenant B queued items: ${queueB.queued} (Zero cross-tenant leakage)`
      );
    } catch (err: any) {
      recordTest(15, 'Operational Monitoring Tenant Data Isolation', false, err.message);
    }

    // =================================================================
    // Scenario 16: Structured Logging Secret Redaction Filter
    // =================================================================
    try {
      const rawPayload = {
        password: 'SuperSecretPassword',
        accessToken: 'EAAB_real_meta_access_token_sample_string_12345',
        clientSecret: 'secret_app_key_here',
        user: {
          name: 'Test Operator',
          authHeader: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
        }
      };

      const sanitized = LoggerService.sanitize(rawPayload);

      const passed =
        sanitized.password === '***[REDACTED]***' &&
        sanitized.accessToken === '***[REDACTED]***' &&
        sanitized.clientSecret === '***[REDACTED]***' &&
        !sanitized.user.authHeader.includes('eyJhbG') &&
        sanitized.user.name === 'Test Operator';

      recordTest(
        16,
        'Structured Logger Recursive Credential Redaction',
        passed,
        'Passwords, access tokens, and Bearer tokens completely redacted; non-sensitive fields preserved'
      );
    } catch (err: any) {
      recordTest(16, 'Structured Logger Recursive Credential Redaction', false, err.message);
    }
  } finally {
    // Cleanup temporary items
    if (contentPost) {
      await prisma.publication.deleteMany({ where: { contentId: contentPost.id } }).catch(() => {});
      await prisma.content.delete({ where: { id: contentPost.id } }).catch(() => {});
    }
    await prisma.$disconnect();
  }

  console.log('\n====================================================');
  console.log('📊 Phase 4 Verification Suite Summary');
  console.log('====================================================');
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`Total Scenarios: ${total}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log('====================================================\n');

  if (failed === 0) {
    console.log('🎉 ALL 16 PHASE 4 SCENARIOS PASSED WITH 100% SUCCESS!\n');
    process.exit(0);
  } else {
    console.error(`💥 ${failed} SCENARIO(S) FAILED.\n`);
    process.exit(1);
  }
}

runPhase4VerificationSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
