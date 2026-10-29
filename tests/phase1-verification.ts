import axios from 'axios';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const API_BASE = 'http://localhost:5000/api';
const prisma = new PrismaClient();

interface TestResult {
  id: number;
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function recordTest(id: number, name: string, passed: boolean, details: string) {
  results.push({ id, name, passed, details });
  const icon = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${icon} [Test ${id}]: ${name} - ${details}`);
}

async function runVerificationSuite() {
  console.log('====================================================');
  console.log('🧪 Starting Phase 1 Production Verification Suite');
  console.log('====================================================\n');

  let tokenTenantA = '';
  let tokenTenantB = '';

  // -----------------------------------------------------------------
  // 1. Successful login with valid credentials
  // -----------------------------------------------------------------
  try {
    const res = await axios.post(`${API_BASE}/auth/login`, {
      email: 'admin@apexdigital.com',
      password: 'Password123!'
    });
    tokenTenantA = res.data.token;
    recordTest(
      1,
      'Successful login with valid credentials',
      res.status === 200 && !!res.data.token && res.data.user.email === 'admin@apexdigital.com',
      `Logged in as ${res.data.user.email}, tenant=${res.data.tenant?.name}`
    );
  } catch (err: any) {
    recordTest(1, 'Successful login with valid credentials', false, err.response?.data?.error || err.message);
  }

  // -----------------------------------------------------------------
  // 2. Rejection of invalid passwords
  // -----------------------------------------------------------------
  try {
    await axios.post(`${API_BASE}/auth/login`, {
      email: 'admin@apexdigital.com',
      password: 'IncorrectPassword999!'
    });
    recordTest(2, 'Rejection of invalid passwords', false, 'Expected 401 but request succeeded');
  } catch (err: any) {
    const status = err.response?.status;
    recordTest(
      2,
      'Rejection of invalid passwords',
      status === 401,
      `Rejected with HTTP ${status}: ${err.response?.data?.error}`
    );
  }

  // -----------------------------------------------------------------
  // 3. Rejection of the old universal password bypass
  // -----------------------------------------------------------------
  try {
    // Create an explicit user whose password is NOT 'Password123!'
    const uniqueTestEmail = `secure.user.${Date.now()}@apexdigital.com`;
    const realSecretPassword = 'RealComplexPassword_2026!#$';
    const passwordHash = await bcrypt.hash(realSecretPassword, 10);

    const testUser = await prisma.user.create({
      data: {
        email: uniqueTestEmail,
        passwordHash,
        name: 'Strict Auth Test User',
        role: 'TEAM_MEMBER',
        isActive: true,
        tenantId: 'tenant-apex'
      }
    });

    // Attempt login using the old bypass password 'Password123!'
    let bypassFailed = false;
    try {
      await axios.post(`${API_BASE}/auth/login`, {
        email: uniqueTestEmail,
        password: 'Password123!'
      });
    } catch (err: any) {
      if (err.response?.status === 401) {
        bypassFailed = true;
      }
    }

    // Now login with the real secret password
    const realLoginRes = await axios.post(`${API_BASE}/auth/login`, {
      email: uniqueTestEmail,
      password: realSecretPassword
    });

    const passed = bypassFailed && realLoginRes.status === 200;
    recordTest(
      3,
      'Rejection of old universal password bypass (Password123!)',
      passed,
      bypassFailed
        ? 'Universal bypass rejected with 401; real password authenticated successfully'
        : 'CRITICAL FAILURE: Backdoor is still active!'
    );

    // Clean up test user
    await prisma.user.delete({ where: { id: testUser.id } });
  } catch (err: any) {
    recordTest(3, 'Rejection of old universal password bypass', false, err.message);
  }

  // -----------------------------------------------------------------
  // 4. Rejection of unauthenticated protected requests
  // -----------------------------------------------------------------
  try {
    await axios.get(`${API_BASE}/businesses`);
    recordTest(4, 'Rejection of unauthenticated protected requests', false, 'Expected 401 Unauthorized');
  } catch (err: any) {
    const status = err.response?.status;
    recordTest(
      4,
      'Rejection of unauthenticated protected requests',
      status === 401,
      `Rejected with HTTP ${status}: ${err.response?.data?.error}`
    );
  }

  // -----------------------------------------------------------------
  // 5. Tenant A being unable to read or modify Tenant B's records
  // -----------------------------------------------------------------
  try {
    // Login as Tenant B
    const resB = await axios.post(`${API_BASE}/auth/login`, {
      email: 'creator@pulsenetwork.com',
      password: 'Password123!'
    });
    tokenTenantB = resB.data.token;

    // Tenant B fetches businesses
    const resBizB = await axios.get(`${API_BASE}/businesses`, {
      headers: { Authorization: `Bearer ${tokenTenantB}` }
    });

    // Tenant A fetches businesses
    const resBizA = await axios.get(`${API_BASE}/businesses`, {
      headers: { Authorization: `Bearer ${tokenTenantA}` }
    });

    const tenantABusinessIds = resBizA.data.businesses.map((b: any) => b.id);
    const tenantBBusinessIds = resBizB.data.businesses.map((b: any) => b.id);

    // Check no intersection
    const intersection = tenantABusinessIds.filter((id: string) => tenantBBusinessIds.includes(id));
    const isolationPassed = intersection.length === 0 && tenantABusinessIds.length > 0;

    recordTest(
      5,
      'Tenant isolation between Tenant A and Tenant B',
      isolationPassed,
      `Tenant A has ${tenantABusinessIds.length} businesses, Tenant B has ${tenantBBusinessIds.length}. Overlap count = ${intersection.length}`
    );
  } catch (err: any) {
    recordTest(5, 'Tenant isolation between Tenant A and Tenant B', false, err.response?.data?.error || err.message);
  }

  // -----------------------------------------------------------------
  // 6. Unauthorized tenant-header overrides being rejected
  // -----------------------------------------------------------------
  try {
    // Tenant A user attempts to supply `x-tenant-id: tenant-pulse` header
    await axios.get(`${API_BASE}/businesses`, {
      headers: {
        Authorization: `Bearer ${tokenTenantA}`,
        'x-tenant-id': 'tenant-pulse'
      }
    });
    recordTest(6, 'Unauthorized tenant-header overrides rejected', false, 'Expected 403 Forbidden on tenant impersonation');
  } catch (err: any) {
    const status = err.response?.status;
    recordTest(
      6,
      'Unauthorized tenant-header overrides rejected',
      status === 403,
      `Rejected with HTTP ${status}: ${err.response?.data?.error}`
    );
  }

  // -----------------------------------------------------------------
  // 7. Creating and retrieving a business through PostgreSQL
  // -----------------------------------------------------------------
  let createdBusinessId = '';
  try {
    const businessName = `Test Enterprise ${Date.now()}`;
    const createRes = await axios.post(
      `${API_BASE}/businesses`,
      {
        name: businessName,
        legalName: `${businessName} Ltd`,
        industry: 'Cloud Infrastructure',
        website: 'https://testenterprise.example.com'
      },
      { headers: { Authorization: `Bearer ${tokenTenantA}` } }
    );

    createdBusinessId = createRes.data.business.id;

    // Verify retrieval via DB query
    const dbRecord = await prisma.business.findUnique({
      where: { id: createdBusinessId }
    });

    const passed = !!dbRecord && dbRecord.name === businessName;
    recordTest(
      7,
      'Creating and retrieving a business through PostgreSQL',
      passed,
      `Business created (id=${createdBusinessId}) and verified directly in PostgreSQL`
    );
  } catch (err: any) {
    recordTest(7, 'Creating and retrieving a business through PostgreSQL', false, err.response?.data?.error || err.message);
  }

  // -----------------------------------------------------------------
  // 8. Creating and retrieving a brand through PostgreSQL
  // -----------------------------------------------------------------
  let createdBrandId = '';
  try {
    const brandName = `Brand Nova ${Date.now()}`;
    const createRes = await axios.post(
      `${API_BASE}/brands`,
      {
        businessId: createdBusinessId,
        name: brandName,
        description: 'Automated test brand for database persistence verification',
        tone: 'Bold, innovative, and technical'
      },
      { headers: { Authorization: `Bearer ${tokenTenantA}` } }
    );

    createdBrandId = createRes.data.brand.id;

    // Verify in PostgreSQL with voiceProfile
    const dbBrand = await prisma.brand.findUnique({
      where: { id: createdBrandId },
      include: { voiceProfile: true }
    });

    const passed = !!dbBrand && dbBrand.name === brandName && !!dbBrand.voiceProfile;
    recordTest(
      8,
      'Creating and retrieving a brand with voice profile through PostgreSQL',
      passed,
      `Brand created (id=${createdBrandId}) with Voice Profile verified in PostgreSQL`
    );
  } catch (err: any) {
    recordTest(8, 'Creating and retrieving a brand through PostgreSQL', false, err.response?.data?.error || err.message);
  }

  // -----------------------------------------------------------------
  // 9. Creating and retrieving content through PostgreSQL
  // -----------------------------------------------------------------
  let createdContentId = '';
  try {
    const caption = `Exciting news from Nova! 🚀 Exploring next-gen observability #CloudTech ${Date.now()}`;
    const createRes = await axios.post(
      `${API_BASE}/content`,
      {
        brandId: createdBrandId,
        title: 'Nova Launch Post',
        caption,
        hashtags: ['#CloudTech', '#Observability'],
        format: 'POST',
        status: 'DRAFT'
      },
      { headers: { Authorization: `Bearer ${tokenTenantA}` } }
    );

    createdContentId = createRes.data.content.id;

    // Verify in PostgreSQL
    const dbContent = await prisma.content.findUnique({
      where: { id: createdContentId },
      include: { versions: true }
    });

    const passed = !!dbContent && dbContent.caption === caption && dbContent.versions.length > 0;
    recordTest(
      9,
      'Creating and retrieving content through PostgreSQL',
      passed,
      `Content post (id=${createdContentId}) with Version 1 persisted in PostgreSQL`
    );
  } catch (err: any) {
    recordTest(9, 'Creating and retrieving content through PostgreSQL', false, err.response?.data?.error || err.message);
  }

  // -----------------------------------------------------------------
  // 10. Persisting data across queries (Surviving without RAM)
  // -----------------------------------------------------------------
  try {
    // Query directly from PostgreSQL through independent Prisma client
    const freshPrisma = new PrismaClient();
    const [bizCheck, brandCheck, contentCheck] = await Promise.all([
      freshPrisma.business.findUnique({ where: { id: createdBusinessId } }),
      freshPrisma.brand.findUnique({ where: { id: createdBrandId } }),
      freshPrisma.content.findUnique({ where: { id: createdContentId } })
    ]);
    await freshPrisma.$disconnect();

    const passed = !!bizCheck && !!brandCheck && !!contentCheck;
    recordTest(
      10,
      'Data survives independently in PostgreSQL database storage',
      passed,
      'All newly created entities verified persistent via clean database connection'
    );
  } catch (err: any) {
    recordTest(10, 'Data survives independently in PostgreSQL', false, err.message);
  }

  // -----------------------------------------------------------------
  // 11. Correct audit-event persistence
  // -----------------------------------------------------------------
  try {
    const recentAuditEvents = await prisma.auditEvent.findMany({
      where: {
        tenantId: 'tenant-apex'
      },
      orderBy: { createdAt: 'desc' },
      take: 5
    });

    const hasLoginAudit = recentAuditEvents.some(e => e.action === 'AUTH_LOGIN');
    const hasBusinessAudit = recentAuditEvents.some(e => e.action === 'BUSINESS_CREATED');
    const passed = recentAuditEvents.length > 0 && (hasLoginAudit || hasBusinessAudit);

    recordTest(
      11,
      'Correct audit-event persistence in PostgreSQL',
      passed,
      `Found ${recentAuditEvents.length} persistent audit events in database (Actions: ${recentAuditEvents.map(e => e.action).slice(0, 3).join(', ')})`
    );
  } catch (err: any) {
    recordTest(11, 'Correct audit-event persistence', false, err.message);
  }

  // -----------------------------------------------------------------
  // 12. Correct handling of invalid input and missing records
  // -----------------------------------------------------------------
  try {
    // Missing required fields
    let missingFieldHandled = false;
    try {
      await axios.post(
        `${API_BASE}/businesses`,
        { industry: 'Tech' }, // missing name
        { headers: { Authorization: `Bearer ${tokenTenantA}` } }
      );
    } catch (err: any) {
      if (err.response?.status === 400) missingFieldHandled = true;
    }

    // Missing record lookup
    let notFoundHandled = false;
    try {
      await axios.get(`${API_BASE}/content/non-existent-content-id-12345`, {
        headers: { Authorization: `Bearer ${tokenTenantA}` }
      });
    } catch (err: any) {
      if (err.response?.status === 404) notFoundHandled = true;
    }

    const passed = missingFieldHandled && notFoundHandled;
    recordTest(
      12,
      'Correct handling of invalid input and missing records',
      passed,
      `Validation error returned 400 (${missingFieldHandled}), missing record returned 404 (${notFoundHandled})`
    );
  } catch (err: any) {
    recordTest(12, 'Correct handling of invalid input and missing records', false, err.message);
  }

  // Clean up test records
  if (createdBusinessId) {
    await prisma.business.delete({ where: { id: createdBusinessId } }).catch(() => {});
  }

  // -----------------------------------------------------------------
  // Final Scorecard
  // -----------------------------------------------------------------
  console.log('\n====================================================');
  console.log('📊 Verification Summary:');
  const passCount = results.filter(r => r.passed).length;
  console.log(`Total Tests: ${results.length} | Passed: ${passCount} | Failed: ${results.length - passCount}`);
  console.log('====================================================\n');

  await prisma.$disconnect();

  if (passCount === results.length) {
    console.log('🎉 ALL 12 MANDATORY AUTOMATED VERIFICATION CHECKS PASSED!');
    process.exit(0);
  } else {
    console.error('❌ SOME TESTS FAILED.');
    process.exit(1);
  }
}

runVerificationSuite().catch(err => {
  console.error('Test suite runner crashed:', err);
  process.exit(1);
});

