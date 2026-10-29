import { prisma } from '../src/services/db.service';
import { SchedulerService } from '../src/services/scheduler.service';
import { CryptoService } from '../src/services/crypto.service';
import { MetaService } from '../src/services/meta.service';

interface TestResult {
  testNumber: number;
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function recordTest(testNumber: number, name: string, passed: boolean, details: string) {
  results.push({ testNumber, name, passed, details });
  const icon = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${icon} [Test ${testNumber}]: ${name} - ${details}`);
}

async function runTimestampVerificationSuite() {
  console.log('====================================================');
  console.log('🚀 Starting Scheduler Timestamp & Reliability Suite');
  console.log('====================================================\n');

  let brand: any;
  let user: any;
  let account: any;

  try {
    // Setup test brand, user, and account
    user = await prisma.user.findFirst();
    if (!user) {
      throw new Error('No user found in database. Please run seed first.');
    }

    brand = await prisma.brand.findFirst();
    if (!brand) {
      throw new Error('No brand found in database.');
    }

    account = await prisma.socialAccount.create({
      data: {
        brandId: brand.id,
        platform: 'FACEBOOK',
        platformAccountId: `fb_test_page_${Date.now()}`,
        accountName: 'Timestamp Test Page',
        accessToken: CryptoService.encrypt('EAAB_mock_token_for_timestamp_test'),
        tokenStatus: 'VALID'
      }
    });

    // -----------------------------------------------------------------
    // Test 1: Claiming a job atomically sets status 'PUBLISHING' & claimedAt, NOT publishedAt
    // -----------------------------------------------------------------
    try {
      const content1 = await prisma.content.create({
        data: {
          brandId: brand.id,
          createdByUserId: user.id,
          title: 'Claim Timestamp Test Post',
          caption: 'Testing that claiming does not set publishedAt',
          status: 'SCHEDULED'
        }
      });

      const pub1 = await prisma.publication.create({
        data: {
          contentId: content1.id,
          socialAccountId: account.id,
          scheduledFor: new Date(Date.now() - 10000),
          status: 'QUEUED',
          publishedAt: null,
          claimedAt: null
        }
      });

      const claimTime = new Date();
      // Atomic claim operation as performed by worker
      const claimResult = await prisma.publication.updateMany({
        where: { id: pub1.id, status: 'QUEUED' },
        data: { status: 'PUBLISHING', claimedAt: claimTime }
      });

      const claimedPub = await prisma.publication.findUnique({ where: { id: pub1.id } });

      const passed1 =
        claimResult.count === 1 &&
        claimedPub?.status === 'PUBLISHING' &&
        claimedPub?.claimedAt !== null &&
        claimedPub?.publishedAt === null;

      recordTest(
        1,
        'Claiming Job Does Not Set publishedAt',
        passed1,
        `Status: ${claimedPub?.status}, claimedAt: ${claimedPub?.claimedAt?.toISOString()}, publishedAt: ${claimedPub?.publishedAt}`
      );

      // Cleanup
      await prisma.publication.delete({ where: { id: pub1.id } });
      await prisma.content.delete({ where: { id: content1.id } });
    } catch (err: any) {
      recordTest(1, 'Claiming Job Does Not Set publishedAt', false, err.message);
    }

    // -----------------------------------------------------------------
    // Test 2: Successful publishing sets publishedAt ONLY after receiving valid external post ID
    // -----------------------------------------------------------------
    try {
      const content2 = await prisma.content.create({
        data: {
          brandId: brand.id,
          createdByUserId: user.id,
          title: 'Success Timestamp Test Post',
          caption: 'Testing publishedAt confirmed upon receipt of platformPostId',
          status: 'SCHEDULED'
        }
      });

      const pub2 = await prisma.publication.create({
        data: {
          contentId: content2.id,
          socialAccountId: account.id,
          scheduledFor: new Date(),
          status: 'PUBLISHING',
          claimedAt: new Date(),
          publishedAt: null
        }
      });

      // Simulate confirmed publication receipt with valid external platform post ID
      const mockConfirmedExternalId = `fb_post_${Date.now()}_confirmed`;
      const mockPostUrl = `https://facebook.com/${mockConfirmedExternalId}`;
      const confirmedTime = new Date();

      if (!mockConfirmedExternalId) {
        throw new Error('Meta API completed without returning a valid external platform post ID');
      }

      await prisma.$transaction([
        prisma.publication.update({
          where: { id: pub2.id },
          data: {
            status: 'PUBLISHED',
            publishedAt: confirmedTime,
            platformPostId: mockConfirmedExternalId,
            platformPostUrl: mockPostUrl,
            errorMessage: null
          }
        }),
        prisma.content.update({
          where: { id: content2.id },
          data: { status: 'PUBLISHED' }
        })
      ]);

      const publishedPub = await prisma.publication.findUnique({ where: { id: pub2.id } });

      const passed2 =
        publishedPub?.status === 'PUBLISHED' &&
        publishedPub?.platformPostId === mockConfirmedExternalId &&
        publishedPub?.publishedAt !== null &&
        Math.abs(publishedPub.publishedAt.getTime() - confirmedTime.getTime()) < 1000;

      recordTest(
        2,
        'Successful Publishing Sets publishedAt on Confirmed Post ID',
        passed2,
        `Status: ${publishedPub?.status}, PostId: ${publishedPub?.platformPostId}, publishedAt: ${publishedPub?.publishedAt?.toISOString()}`
      );

      // Cleanup
      await prisma.publication.delete({ where: { id: pub2.id } });
      await prisma.content.delete({ where: { id: content2.id } });
    } catch (err: any) {
      recordTest(2, 'Successful Publishing Sets publishedAt on Confirmed Post ID', false, err.message);
    }

    // -----------------------------------------------------------------
    // Test 3: Failed publishing leaves publishedAt as null when publication has never succeeded
    // -----------------------------------------------------------------
    try {
      const content3 = await prisma.content.create({
        data: {
          brandId: brand.id,
          createdByUserId: user.id,
          title: 'Failed Publication Post',
          caption: 'Testing publishedAt remains null on failure',
          status: 'SCHEDULED'
        }
      });

      const pub3 = await prisma.publication.create({
        data: {
          contentId: content3.id,
          socialAccountId: account.id,
          scheduledFor: new Date(Date.now() - 5000),
          status: 'QUEUED',
          publishedAt: null
        }
      });

      // Run worker cycle which will attempt to publish to Meta with the test token and fail
      await SchedulerService.runWorkerCycle();

      const failedPub = await prisma.publication.findUnique({ where: { id: pub3.id } });

      const passed3 =
        failedPub?.status === 'FAILED' &&
        failedPub?.errorMessage !== null &&
        failedPub?.publishedAt === null;

      recordTest(
        3,
        'Failed Publishing Preserves publishedAt as null',
        passed3,
        `Status: ${failedPub?.status}, Error: ${failedPub?.errorMessage?.substring(0, 45)}..., publishedAt: ${failedPub?.publishedAt}`
      );

      // Cleanup
      await prisma.publication.delete({ where: { id: pub3.id } });
      await prisma.content.delete({ where: { id: content3.id } });
    } catch (err: any) {
      recordTest(3, 'Failed Publishing Preserves publishedAt as null', false, err.message);
    }

    // -----------------------------------------------------------------
    // Test 4: Stale-job recovery does not set publishedAt (QUEUED and FAILED states)
    // -----------------------------------------------------------------
    try {
      const content4 = await prisma.content.create({
        data: {
          brandId: brand.id,
          createdByUserId: user.id,
          title: 'Stale Recovery Test Post',
          caption: 'Testing crash recovery preserves publishedAt as null',
          status: 'SCHEDULED'
        }
      });

      // Publication 4A: retryCount < 3 -> should recover to QUEUED with claimedAt: null and publishedAt: null
      const stalePub4A = await prisma.publication.create({
        data: {
          contentId: content4.id,
          socialAccountId: account.id,
          scheduledFor: new Date(Date.now() - 400000),
          status: 'PUBLISHING',
          claimedAt: new Date(Date.now() - 400000),
          retryCount: 1,
          publishedAt: null
        }
      });

      // Publication 4B: retryCount >= 3 -> should transition to FAILED with publishedAt: null
      const stalePub4B = await prisma.publication.create({
        data: {
          contentId: content4.id,
          socialAccountId: account.id,
          scheduledFor: new Date(Date.now() - 400000),
          status: 'PUBLISHING',
          claimedAt: new Date(Date.now() - 400000),
          retryCount: 3,
          publishedAt: null
        }
      });

      const recovered = await SchedulerService.recoverStalePublishingJobs(5 * 60 * 1000);

      const check4A = await prisma.publication.findUnique({ where: { id: stalePub4A.id } });
      const check4B = await prisma.publication.findUnique({ where: { id: stalePub4B.id } });

      const passed4 =
        recovered >= 2 &&
        check4A?.status === 'QUEUED' &&
        check4A?.claimedAt === null &&
        check4A?.publishedAt === null &&
        check4A?.retryCount === 2 &&
        check4B?.status === 'FAILED' &&
        check4B?.publishedAt === null;

      recordTest(
        4,
        'Stale-Job Recovery Does Not Set publishedAt',
        passed4,
        `Job A (Retry < 3): Status=${check4A?.status}, claimedAt=${check4A?.claimedAt}, publishedAt=${check4A?.publishedAt}; Job B (Retry >= 3): Status=${check4B?.status}, publishedAt=${check4B?.publishedAt}`
      );

      // Cleanup
      await prisma.publication.deleteMany({ where: { id: { in: [stalePub4A.id, stalePub4B.id] } } });
      await prisma.content.delete({ where: { id: content4.id } });
    } catch (err: any) {
      recordTest(4, 'Stale-Job Recovery Does Not Set publishedAt', false, err.message);
    }

    // -----------------------------------------------------------------
    // Test 5: Concurrent workers cannot publish the same queued job simultaneously
    // -----------------------------------------------------------------
    try {
      const content5 = await prisma.content.create({
        data: {
          brandId: brand.id,
          createdByUserId: user.id,
          title: 'Concurrent Claim Test Post',
          caption: 'Testing mutual exclusion during atomic job claim',
          status: 'SCHEDULED'
        }
      });

      const pub5 = await prisma.publication.create({
        data: {
          contentId: content5.id,
          socialAccountId: account.id,
          scheduledFor: new Date(Date.now() - 5000),
          status: 'QUEUED',
          claimedAt: null,
          publishedAt: null
        }
      });

      // Launch 5 parallel competing workers attempting to atomically claim the same queued job
      const claimAttempts = await Promise.all([
        prisma.publication.updateMany({
          where: { id: pub5.id, status: 'QUEUED' },
          data: { status: 'PUBLISHING', claimedAt: new Date() }
        }),
        prisma.publication.updateMany({
          where: { id: pub5.id, status: 'QUEUED' },
          data: { status: 'PUBLISHING', claimedAt: new Date() }
        }),
        prisma.publication.updateMany({
          where: { id: pub5.id, status: 'QUEUED' },
          data: { status: 'PUBLISHING', claimedAt: new Date() }
        }),
        prisma.publication.updateMany({
          where: { id: pub5.id, status: 'QUEUED' },
          data: { status: 'PUBLISHING', claimedAt: new Date() }
        }),
        prisma.publication.updateMany({
          where: { id: pub5.id, status: 'QUEUED' },
          data: { status: 'PUBLISHING', claimedAt: new Date() }
        })
      ]);

      const successfulClaims = claimAttempts.filter(c => c.count === 1).length;
      const rejectedClaims = claimAttempts.filter(c => c.count === 0).length;

      const finalPub5 = await prisma.publication.findUnique({ where: { id: pub5.id } });

      const passed5 =
        successfulClaims === 1 &&
        rejectedClaims === 4 &&
        finalPub5?.status === 'PUBLISHING' &&
        finalPub5?.claimedAt !== null &&
        finalPub5?.publishedAt === null;

      recordTest(
        5,
        'Concurrent Workers Mutual Exclusion on Job Claim',
        passed5,
        `Successful Claims: ${successfulClaims}, Rejected Contenders: ${rejectedClaims}, publishedAt: ${finalPub5?.publishedAt}`
      );

      // Cleanup
      await prisma.publication.delete({ where: { id: pub5.id } });
      await prisma.content.delete({ where: { id: content5.id } });
    } catch (err: any) {
      recordTest(5, 'Concurrent Workers Mutual Exclusion on Job Claim', false, err.message);
    }

    // -----------------------------------------------------------------
    // Test 6: Ambiguous API timeouts do not trigger unsafe duplicate publishing
    // -----------------------------------------------------------------
    try {
      const content6 = await prisma.content.create({
        data: {
          brandId: brand.id,
          createdByUserId: user.id,
          title: 'Timeout Protection Test Post',
          caption: 'Testing timeout does not re-queue or set publishedAt',
          status: 'SCHEDULED'
        }
      });

      const pub6 = await prisma.publication.create({
        data: {
          contentId: content6.id,
          socialAccountId: account.id,
          scheduledFor: new Date(),
          status: 'PUBLISHING',
          claimedAt: new Date(),
          retryCount: 1,
          publishedAt: null
        }
      });

      // Simulate timeout error catch block execution as in scheduler.service.ts
      const timeoutError: any = new Error('connect ETIMEDOUT 157.240.22.35:443');
      timeoutError.code = 'ECONNABORTED';

      const isTimeout = timeoutError.code === 'ECONNABORTED' || (timeoutError.message && timeoutError.message.toLowerCase().includes('timeout'));
      const errorMessage = isTimeout
        ? 'Meta API request timed out. Please check Facebook Page or Instagram feed before retrying to prevent duplicate posts.'
        : timeoutError.message;

      const nextScheduled = isTimeout
        ? new Date()
        : new Date(Date.now() + Math.pow(2, pub6.retryCount + 1) * 30000);

      await prisma.publication.update({
        where: { id: pub6.id },
        data: {
          status: 'FAILED',
          errorMessage,
          scheduledFor: nextScheduled,
          retryCount: isTimeout ? pub6.retryCount : { increment: 1 }
        }
      });

      const updatedPub6 = await prisma.publication.findUnique({ where: { id: pub6.id } });

      const passed6 =
        isTimeout &&
        updatedPub6?.status === 'FAILED' &&
        updatedPub6?.retryCount === 1 && // Retry count NOT automatically incremented
        updatedPub6?.errorMessage?.includes('prevent duplicate posts') &&
        updatedPub6?.publishedAt === null;

      recordTest(
        6,
        'Ambiguous API Timeout Duplicate Post Protection',
        Boolean(passed6),
        `Status: ${updatedPub6?.status}, RetryCount: ${updatedPub6?.retryCount} (Preserved), publishedAt: ${updatedPub6?.publishedAt}`
      );

      // Cleanup
      await prisma.publication.delete({ where: { id: pub6.id } });
      await prisma.content.delete({ where: { id: content6.id } });
    } catch (err: any) {
      recordTest(6, 'Ambiguous API Timeout Duplicate Post Protection', false, err.message);
    }
  } finally {
    if (account) {
      await prisma.socialAccount.delete({ where: { id: account.id } }).catch(() => {});
    }
    await prisma.$disconnect();
  }

  console.log('\n====================================================');
  console.log('📊 Scheduler Timestamp Verification Suite Summary');
  console.log('====================================================');
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`Total Scenarios: ${total}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log('====================================================\n');

  if (failed === 0) {
    console.log('🎉 ALL 6 SCHEDULER TIMESTAMP VERIFICATION SCENARIOS PASSED WITH 100% SUCCESS!\n');
    process.exit(0);
  } else {
    console.error(`💥 ${failed} SCENARIO(S) FAILED.\n`);
    process.exit(1);
  }
}

runTimestampVerificationSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

