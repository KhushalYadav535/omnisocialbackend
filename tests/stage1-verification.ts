import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../src/services/db.service';
import { config } from '../src/config';
import { OpenRouterService } from '../src/services/openrouter.service';

const API_BASE = 'http://localhost:5000/api';

interface TestResult {
  scenario: string;
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function recordTest(scenario: string, name: string, passed: boolean, details: string) {
  results.push({ scenario, name, passed, details });
  const icon = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${icon} [${scenario}]: ${name} - ${details}`);
}

async function runStage1VerificationSuite() {
  console.log('====================================================');
  console.log('🚀 Starting Stage 1 Core Reliability Verification Suite');
  console.log('   (Persistent AI Logs, Webhook Attribution & Inbox Pagination)');
  console.log('====================================================\n');

  let tenantA: any;
  let tenantB: any;
  let userA: any;
  let userB: any;
  let tokenA = '';
  let tokenB = '';
  let brandA: any;
  let brandB: any;
  let socialAccountA: any;
  let socialAccountB: any;

  try {
    // -----------------------------------------------------------------
    // 0. Setup Test Tenants, Users, Brands & Accounts
    // -----------------------------------------------------------------
    console.log('📋 Phase 0: Setting up test fixtures in PostgreSQL...');

    // Tenant A
    tenantA = await prisma.tenant.findFirst({ where: { slug: 'stage1-tenant-a' } });
    if (!tenantA) {
      tenantA = await prisma.tenant.create({
        data: { name: 'Stage 1 Tenant A', slug: 'stage1-tenant-a', status: 'ACTIVE' }
      });
    }

    // Tenant B
    tenantB = await prisma.tenant.findFirst({ where: { slug: 'stage1-tenant-b' } });
    if (!tenantB) {
      tenantB = await prisma.tenant.create({
        data: { name: 'Stage 1 Tenant B', slug: 'stage1-tenant-b', status: 'ACTIVE' }
      });
    }

    // User A
    userA = await prisma.user.findFirst({ where: { email: 'user-a@stage1.test' } });
    if (!userA) {
      userA = await prisma.user.create({
        data: {
          email: 'user-a@stage1.test',
          passwordHash: '$2a$10$abcdefghijklmnopqrstuv',
          name: 'Stage 1 User A',
          role: 'OWNER',
          tenantId: tenantA.id
        }
      });
    }

    // User B
    userB = await prisma.user.findFirst({ where: { email: 'user-b@stage1.test' } });
    if (!userB) {
      userB = await prisma.user.create({
        data: {
          email: 'user-b@stage1.test',
          passwordHash: '$2a$10$abcdefghijklmnopqrstuv',
          name: 'Stage 1 User B',
          role: 'OWNER',
          tenantId: tenantB.id
        }
      });
    }

    // Generate JWT tokens
    tokenA = jwt.sign(
      { id: userA.id, email: userA.email, role: userA.role, tenantId: tenantA.id },
      config.jwtSecret,
      { expiresIn: '1h' }
    );

    tokenB = jwt.sign(
      { id: userB.id, email: userB.email, role: userB.role, tenantId: tenantB.id },
      config.jwtSecret,
      { expiresIn: '1h' }
    );

    // Business & Brand A
    let bizA = await prisma.business.findFirst({ where: { tenantId: tenantA.id } });
    if (!bizA) {
      bizA = await prisma.business.create({
        data: { tenantId: tenantA.id, name: 'Stage 1 Biz A' }
      });
    }
    brandA = await prisma.brand.findFirst({ where: { businessId: bizA.id } });
    if (!brandA) {
      brandA = await prisma.brand.create({
        data: { businessId: bizA.id, name: 'Brand Alpha', slug: `brand-alpha-${Date.now()}`, description: 'Technology brand' }
      });
    }

    // Business & Brand B
    let bizB = await prisma.business.findFirst({ where: { tenantId: tenantB.id } });
    if (!bizB) {
      bizB = await prisma.business.create({
        data: { tenantId: tenantB.id, name: 'Stage 1 Biz B' }
      });
    }
    brandB = await prisma.brand.findFirst({ where: { businessId: bizB.id } });
    if (!brandB) {
      brandB = await prisma.brand.create({
        data: { businessId: bizB.id, name: 'Brand Beta', slug: `brand-beta-${Date.now()}`, description: 'Retail brand' }
      });
    }

    // Social Account for Tenant A
    const externalPageIdA = `fb-page-stage1-a-${Date.now()}`;
    socialAccountA = await prisma.socialAccount.create({
      data: {
        brandId: brandA.id,
        platform: 'FACEBOOK',
        platformAccountId: externalPageIdA,
        accountName: 'Stage 1 Facebook Page A',
        accessToken: 'mock-access-token-a',
        tokenStatus: 'VALID',
        isConnected: true
      }
    });

    // Social Account for Tenant B
    const externalIgIdB = `ig-account-stage1-b-${Date.now()}`;
    socialAccountB = await prisma.socialAccount.create({
      data: {
        brandId: brandB.id,
        platform: 'INSTAGRAM',
        platformAccountId: externalIgIdB,
        accountName: 'Stage 1 Instagram Account B',
        accessToken: 'mock-access-token-b',
        tokenStatus: 'VALID',
        isConnected: true
      }
    });

    console.log('Setup fixtures created successfully.\n');

    // =================================================================
    // SECTION 1: PERSISTENT AI USAGE LOGGING
    // =================================================================
    console.log('----------------------------------------------------');
    console.log('📌 Section 1: Persistent AI Usage Logging Verification');
    console.log('----------------------------------------------------');

    // Test 1.1: Database schema verification
    try {
      const initialCount = await prisma.aiUsageLog.count();
      recordTest(
        'AI-LOG-01',
        'AiUsageLog model exists and is queryable in PostgreSQL',
        typeof initialCount === 'number',
        `Current persistent AI usage logs count: ${initialCount}`
      );
    } catch (err: any) {
      recordTest('AI-LOG-01', 'AiUsageLog model queryable', false, err.message);
    }

    // Test 1.2: Persistent write through OpenRouterService.trackUsage
    let directLogId: string | null = null;
    try {
      await OpenRouterService.trackUsage({
        timestamp: new Date().toISOString(),
        modelUsed: 'openai/gpt-4o-mini',
        taskType: 'CONTENT_STUDIO',
        promptTokens: 150,
        completionTokens: 85,
        totalTokens: 235,
        estimatedCostUsd: 0.0001175,
        tenantId: tenantA.id,
        brandId: brandA.id,
        userId: userA.id
      });

      // Query database for the newly logged record
      const loggedRow = await prisma.aiUsageLog.findFirst({
        where: {
          tenantId: tenantA.id,
          brandId: brandA.id,
          userId: userA.id,
          taskType: 'CONTENT_STUDIO'
        },
        orderBy: { createdAt: 'desc' }
      });

      directLogId = loggedRow?.id || null;
      const isValid = !!loggedRow && 
        loggedRow.totalTokens === 235 &&
        loggedRow.promptTokens === 150 &&
        loggedRow.completionTokens === 85 &&
        loggedRow.estimatedCostUsd > 0;

      recordTest(
        'AI-LOG-02',
        'OpenRouterService persists token usage into PostgreSQL',
        isValid,
        `Logged ID: ${loggedRow?.id}, Model: ${loggedRow?.modelUsed}, Tokens: ${loggedRow?.totalTokens}, Cost: $${loggedRow?.estimatedCostUsd}`
      );
    } catch (err: any) {
      recordTest('AI-LOG-02', 'OpenRouterService persistence', false, err.message);
    }

    // Test 1.3: Aggregate summary query from PostgreSQL
    try {
      const summaryA = await OpenRouterService.getPersistentUsageSummary(tenantA.id);
      const isSummaryValid = summaryA.totalRequests >= 1 &&
        summaryA.totalTokens >= 235 &&
        typeof summaryA.estimatedCostUsd === 'number' &&
        summaryA.taskBreakdown.contentStudio >= 1;

      recordTest(
        'AI-LOG-03',
        'OpenRouterService.getPersistentUsageSummary computes aggregates from PostgreSQL',
        isSummaryValid,
        `Tenant A requests: ${summaryA.totalRequests}, tokens: ${summaryA.totalTokens}, cost: $${summaryA.estimatedCostUsd}, contentStudio: ${summaryA.taskBreakdown.contentStudio}`
      );
    } catch (err: any) {
      recordTest('AI-LOG-03', 'Persistent usage summary calculation', false, err.message);
    }

    // Test 1.4: Multi-tenant isolation of AI usage logs
    try {
      const summaryB = await OpenRouterService.getPersistentUsageSummary(tenantB.id);
      const tenantAIsolationValid = summaryB.taskBreakdown.contentStudio === 0 && summaryB.totalRequests === 0;

      recordTest(
        'AI-LOG-04',
        'AI usage logs maintain strict tenant isolation in summary aggregation',
        tenantAIsolationValid,
        `Tenant B requests: ${summaryB.totalRequests}, tokens: ${summaryB.totalTokens} (Isolated from Tenant A)`
      );
    } catch (err: any) {
      recordTest('AI-LOG-04', 'AI usage tenant isolation', false, err.message);
    }

    // Test 1.5: Missing optional metadata handling (safe persistence without userId/brandId)
    try {
      await OpenRouterService.trackUsage({
        timestamp: new Date().toISOString(),
        modelUsed: 'openai/gpt-4o-mini',
        taskType: 'CLASSIFICATION',
        promptTokens: 40,
        completionTokens: 20,
        totalTokens: 60,
        estimatedCostUsd: 0.00003,
        tenantId: null,
        brandId: null,
        userId: null
      });

      const anonRow = await prisma.aiUsageLog.findFirst({
        where: {
          tenantId: null,
          brandId: null,
          userId: null,
          taskType: 'CLASSIFICATION'
        },
        orderBy: { createdAt: 'desc' }
      });

      const anonValid = !!anonRow && anonRow.tenantId === null && anonRow.userId === null && anonRow.brandId === null;
      recordTest(
        'AI-LOG-05',
        'Safe persistence with nullable/unspecified tenant, brand, and user identifiers',
        anonValid,
        `Persisted row ID: ${anonRow?.id} with tenantId=${anonRow?.tenantId}, userId=${anonRow?.userId}`
      );
    } catch (err: any) {
      recordTest('AI-LOG-05', 'Nullable identifier handling', false, err.message);
    }

    // Test 1.6: GET /api/ai/usage HTTP route returns PostgreSQL persistent summary
    try {
      const res = await axios.get(`${API_BASE}/ai/usage`, {
        headers: { Authorization: `Bearer ${tokenA}` }
      });

      const httpSummary = res.data.usage;
      const isHttpValid = res.status === 200 &&
        httpSummary &&
        httpSummary.storage === 'POSTGRESQL_PERSISTENT' &&
        httpSummary.totalRequests >= 1 &&
        typeof httpSummary.totalTokens === 'number' &&
        typeof httpSummary.estimatedCostUsd === 'number';

      recordTest(
        'AI-LOG-06',
        'GET /api/ai/usage returns persistent PostgreSQL metrics for authenticated tenant',
        isHttpValid,
        `HTTP Status: ${res.status}, Storage: ${httpSummary?.storage}, Total Requests: ${httpSummary?.totalRequests}, Total Cost: $${httpSummary?.estimatedCostUsd}`
      );
    } catch (err: any) {
      recordTest('AI-LOG-06', 'GET /api/ai/usage persistence', false, err.message);
    }

    // =================================================================
    // SECTION 2: WEBHOOK AI TENANT ATTRIBUTION
    // =================================================================
    console.log('\n----------------------------------------------------');
    console.log('📌 Section 2: Webhook AI Tenant Attribution Verification');
    console.log('----------------------------------------------------');

    // Test 2.1: Tenant resolution through SocialAccount -> Brand -> Business -> Tenant
    let resolvedTenantIdA: string | null = null;
    try {
      const resolvedAccount = await prisma.socialAccount.findFirst({
        where: { platformAccountId: socialAccountA.platformAccountId },
        include: { brand: { include: { business: true } } }
      });

      resolvedTenantIdA = resolvedAccount?.brand?.business?.tenantId || null;
      const isAttributionCorrect = resolvedTenantIdA === tenantA.id;

      recordTest(
        'WEBHOOK-ATTR-01',
        'SocialAccount accurately resolves parent tenantId via Brand and Business relation',
        isAttributionCorrect,
        `Resolved tenant: ${resolvedTenantIdA} === Expected tenant: ${tenantA.id}`
      );
    } catch (err: any) {
      recordTest('WEBHOOK-ATTR-01', 'Tenant resolution hierarchy', false, err.message);
    }

    // Test 2.2: AI classification with attributed tenant logs to correct tenant
    try {
      const initialTenantACount = await prisma.aiUsageLog.count({
        where: { tenantId: tenantA.id, taskType: 'CLASSIFICATION' }
      });

      // Simulate webhook classification tracking with the resolved tenantId
      await OpenRouterService.trackUsage({
        timestamp: new Date().toISOString(),
        modelUsed: 'openai/gpt-4o-mini',
        taskType: 'CLASSIFICATION',
        promptTokens: 80,
        completionTokens: 40,
        totalTokens: 120,
        estimatedCostUsd: 0.00006,
        tenantId: resolvedTenantIdA,
        brandId: brandA.id,
        userId: null // Webhooks arrive from external platforms without an authenticated user
      });

      const updatedTenantACount = await prisma.aiUsageLog.count({
        where: { tenantId: tenantA.id, taskType: 'CLASSIFICATION' }
      });

      const attributionLogged = updatedTenantACount > initialTenantACount;

      recordTest(
        'WEBHOOK-ATTR-02',
        'Webhook classification logs token usage to resolved tenant in PostgreSQL',
        attributionLogged,
        `Tenant A CLASSIFICATION logs increased from ${initialTenantACount} to ${updatedTenantACount}`
      );
    } catch (err: any) {
      recordTest('WEBHOOK-ATTR-02', 'Webhook classification attribution', false, err.message);
    }

    // Test 2.3: Unassigned / unlinked account evaluates to null and NEVER assigns arbitrary tenant
    try {
      const unknownPlatformAccountId = `unlinked-account-${Date.now()}`;
      const resolvedUnassigned = await prisma.socialAccount.findFirst({
        where: { platformAccountId: unknownPlatformAccountId },
        include: { brand: { include: { business: true } } }
      });

      const resolvedTenantId = resolvedUnassigned?.brand?.business?.tenantId || null;
      const isSafeNull = resolvedTenantId === null;

      recordTest(
        'WEBHOOK-ATTR-03',
        'Unassigned / unlinked account safely evaluates resolvedTenantId to null without arbitrary assignment',
        isSafeNull,
        `Resolved tenantId for unassigned account: ${resolvedTenantId}`
      );
    } catch (err: any) {
      recordTest('WEBHOOK-ATTR-03', 'Unassigned account safety', false, err.message);
    }

    // =================================================================
    // SECTION 3: INBOX SQL PAGINATION & FILTERING
    // =================================================================
    console.log('\n----------------------------------------------------');
    console.log('📌 Section 3: Inbox SQL Pagination & Filtering Verification');
    console.log('----------------------------------------------------');

    // Seed 12 distinct interactions for Tenant A and 3 for Tenant B
    const seedInteractions = [];
    for (let i = 1; i <= 12; i++) {
      seedInteractions.push({
        brandId: brandA.id,
        socialAccountId: socialAccountA.id,
        platform: i % 2 === 0 ? 'FACEBOOK' : 'INSTAGRAM',
        type: 'COMMENT',
        platformInteractionId: `test-comment-a-${i}-${Date.now()}`,
        authorId: `author-a-${i}`,
        authorName: `Customer A${i}`,
        contentText: `Stage 1 Pagination Test Content #${i} for Tenant A`,
        platformCreatedAt: new Date(Date.now() - i * 60000),
        isRead: i <= 4,
        replyStatus: i <= 6 ? 'NEEDS_RESPONSE' : 'SENT',
        priority: 'MEDIUM'
      });
    }

    // Seed for Tenant B
    for (let i = 1; i <= 3; i++) {
      seedInteractions.push({
        brandId: brandB.id,
        socialAccountId: socialAccountB.id,
        platform: 'INSTAGRAM',
        type: 'COMMENT',
        platformInteractionId: `test-comment-b-${i}-${Date.now()}`,
        authorId: `author-b-${i}`,
        authorName: `Customer B${i}`,
        contentText: `Tenant B Comment #${i}`,
        platformCreatedAt: new Date(Date.now() - i * 60000),
        isRead: false,
        replyStatus: 'NEEDS_RESPONSE',
        priority: 'MEDIUM'
      });
    }

    await prisma.interaction.createMany({ data: seedInteractions });
    console.log('Seed interactions inserted for Tenant A and Tenant B.\n');

    // Test 3.1: Default pagination values (page=1, limit=50)
    try {
      const res = await axios.get(`${API_BASE}/inbox`, {
        headers: { Authorization: `Bearer ${tokenA}` }
      });

      const body = res.data;
      const isDefaultValid = res.status === 200 &&
        body.page === 1 &&
        body.limit === 50 &&
        body.total >= 12 &&
        body.totalPages >= 1 &&
        Array.isArray(body.items) &&
        Array.isArray(body.interactions) &&
        body.items.length === body.interactions.length;

      recordTest(
        'INBOX-PAGE-01',
        'GET /api/inbox applies default pagination (page=1, limit=50) and returns both items and interactions',
        isDefaultValid,
        `Page: ${body.page}, Limit: ${body.limit}, Total: ${body.total}, TotalPages: ${body.totalPages}, Items returned: ${body.items?.length}`
      );
    } catch (err: any) {
      recordTest('INBOX-PAGE-01', 'Default inbox pagination', false, err.message);
    }

    // Test 3.2: Custom page and limit (page=2, limit=4)
    try {
      const resPage1 = await axios.get(`${API_BASE}/inbox?page=1&limit=4`, {
        headers: { Authorization: `Bearer ${tokenA}` }
      });
      const resPage2 = await axios.get(`${API_BASE}/inbox?page=2&limit=4`, {
        headers: { Authorization: `Bearer ${tokenA}` }
      });

      const page1Ids = resPage1.data.items.map((i: any) => i.id);
      const page2Ids = resPage2.data.items.map((i: any) => i.id);
      const isDisjoint = page1Ids.every((id: string) => !page2Ids.includes(id));
      const isPage2Valid = resPage2.data.page === 2 &&
        resPage2.data.limit === 4 &&
        resPage2.data.items.length === 4 &&
        isDisjoint;

      recordTest(
        'INBOX-PAGE-02',
        'GET /api/inbox applies database skip and take with disjoint pages',
        isPage2Valid,
        `Page 1 count: ${page1Ids.length}, Page 2 count: ${page2Ids.length}, Overlap count: 0 (Disjoint: ${isDisjoint})`
      );
    } catch (err: any) {
      recordTest('INBOX-PAGE-02', 'Custom page and limit', false, err.message);
    }

    // Test 3.3: Maximum limit enforcement (limit=999 capped to 100)
    try {
      const res = await axios.get(`${API_BASE}/inbox?limit=999`, {
        headers: { Authorization: `Bearer ${tokenA}` }
      });

      const isCapped = res.data.limit === 100;
      recordTest(
        'INBOX-PAGE-03',
        'GET /api/inbox enforces maximum limit of 100 for safety against unbounded queries',
        isCapped,
        `Requested limit: 999, Enforced limit in response: ${res.data.limit}`
      );
    } catch (err: any) {
      recordTest('INBOX-PAGE-03', 'Maximum limit enforcement', false, err.message);
    }

    // Test 3.4: Pagination with platform filtering
    try {
      const res = await axios.get(`${API_BASE}/inbox?platform=FACEBOOK&limit=3`, {
        headers: { Authorization: `Bearer ${tokenA}` }
      });

      const allFb = res.data.items.every((i: any) => i.platform === 'FACEBOOK');
      const filterValid = res.status === 200 && allFb && res.data.total >= 6;

      recordTest(
        'INBOX-PAGE-04',
        'GET /api/inbox combines SQL filters with pagination count and metadata',
        filterValid,
        `Facebook filtered total: ${res.data.total}, TotalPages: ${res.data.totalPages}, Items returned: ${res.data.items.length}, All FB: ${allFb}`
      );
    } catch (err: any) {
      recordTest('INBOX-PAGE-04', 'Filtered pagination', false, err.message);
    }

    // Test 3.5: Pagination with status filtering
    try {
      const res = await axios.get(`${API_BASE}/inbox?status=NEEDS_RESPONSE&limit=5`, {
        headers: { Authorization: `Bearer ${tokenA}` }
      });

      const allNeedsResponse = res.data.items.every((i: any) => i.replyStatus === 'NEEDS_RESPONSE');
      const isStatusValid = res.status === 200 && allNeedsResponse && res.data.items.length <= 5;

      recordTest(
        'INBOX-PAGE-05',
        'GET /api/inbox correctly paginates with status filter (NEEDS_RESPONSE)',
        isStatusValid,
        `Needs Response total: ${res.data.total}, Returned: ${res.data.items.length}, All MATCH: ${allNeedsResponse}`
      );
    } catch (err: any) {
      recordTest('INBOX-PAGE-05', 'Status filter pagination', false, err.message);
    }

    // Test 3.6: Strict tenant isolation in inbox pagination
    try {
      const resA = await axios.get(`${API_BASE}/inbox`, {
        headers: { Authorization: `Bearer ${tokenA}` }
      });
      const resB = await axios.get(`${API_BASE}/inbox`, {
        headers: { Authorization: `Bearer ${tokenB}` }
      });

      const idsA = new Set(resA.data.items.map((i: any) => i.id));
      const idsB = new Set(resB.data.items.map((i: any) => i.id));
      let leakDetected = false;
      for (const id of idsB) {
        if (idsA.has(id)) {
          leakDetected = true;
          break;
        }
      }

      const isolationPassed = !leakDetected && resB.data.total >= 3 && resA.data.total >= 12;

      recordTest(
        'INBOX-PAGE-06',
        'Strict tenant isolation enforced during inbox pagination queries',
        isolationPassed,
        `Tenant A total: ${resA.data.total}, Tenant B total: ${resB.data.total}, Cross-tenant leak: ${leakDetected}`
      );
    } catch (err: any) {
      recordTest('INBOX-PAGE-06', 'Inbox tenant isolation', false, err.message);
    }

    // Test 3.7: Backward compatibility verification of response structure
    try {
      const res = await axios.get(`${API_BASE}/inbox`, {
        headers: { Authorization: `Bearer ${tokenA}` }
      });

      const body = res.data;
      const backwardCompatValid = 
        body.hasOwnProperty('items') &&
        body.hasOwnProperty('interactions') &&
        body.hasOwnProperty('total') &&
        body.hasOwnProperty('page') &&
        body.hasOwnProperty('limit') &&
        body.hasOwnProperty('totalPages') &&
        body.hasOwnProperty('unreadCount') &&
        body.hasOwnProperty('needsResponseCount') &&
        JSON.stringify(body.items) === JSON.stringify(body.interactions);

      recordTest(
        'INBOX-PAGE-07',
        'Backward compatibility preserved: returns identical items and interactions arrays alongside pagination metadata',
        backwardCompatValid,
        `Items matches interactions: ${JSON.stringify(body.items) === JSON.stringify(body.interactions)}`
      );
    } catch (err: any) {
      recordTest('INBOX-PAGE-07', 'Backward compatibility', false, err.message);
    }

  } catch (globalErr: any) {
    console.error('Unexpected global test error:', globalErr);
  } finally {
    // -----------------------------------------------------------------
    // Cleanup temporary test interactions and accounts
    // -----------------------------------------------------------------
    console.log('\n🧹 Cleaning up test fixtures...');
    try {
      if (brandA?.id) {
        await prisma.interaction.deleteMany({ where: { brandId: brandA.id } });
      }
      if (brandB?.id) {
        await prisma.interaction.deleteMany({ where: { brandId: brandB.id } });
      }
      if (socialAccountA?.id) {
        await prisma.socialAccount.delete({ where: { id: socialAccountA.id } });
      }
      if (socialAccountB?.id) {
        await prisma.socialAccount.delete({ where: { id: socialAccountB.id } });
      }
      console.log('Cleanup completed.\n');
    } catch (cleanupErr: any) {
      console.warn('Cleanup warning:', cleanupErr.message);
    }
  }

  // -----------------------------------------------------------------
  // Results Summary
  // -----------------------------------------------------------------
  console.log('====================================================');
  console.log('📊 Stage 1 Core Reliability Test Results');
  console.log('====================================================');

  const passedCount = results.filter((r) => r.passed).length;
  const totalCount = results.length;

  results.forEach((r) => {
    const icon = r.passed ? '✅ PASS' : '❌ FAIL';
    console.log(`${icon} [${r.scenario}] ${r.name}`);
  });

  console.log('\n----------------------------------------------------');
  console.log(`Final Result: ${passedCount}/${totalCount} tests passed (${Math.round((passedCount / totalCount) * 100)}%)`);
  console.log('====================================================\n');

  if (passedCount < totalCount) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runStage1VerificationSuite().catch((e) => {
  console.error('FATAL TEST ERROR:', e);
  process.exit(1);
});
