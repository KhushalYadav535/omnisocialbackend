import { Router, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../services/db.service';
import { LinkedInService, LinkedInApiError } from '../services/linkedin.service';
import { CryptoService } from '../services/crypto.service';
import { AuditService } from '../services/audit.service';
import { authenticateToken, requireTenant, AuthRequest } from '../middleware/auth.middleware';
import { config } from '../config';

const router = Router();

router.use(authenticateToken);
router.use(requireTenant);

function sanitizeAccount(account: any) {
  const { accessToken, ...safeAccount } = account;
  return {
    ...safeAccount,
    hasToken: Boolean(accessToken),
    isTokenEncrypted: Boolean(accessToken && CryptoService.isEncrypted(accessToken))
  };
}

/**
 * 1. Generate LinkedIn 1-Click OAuth URL with signed CSRF state and nonce
 */
router.get('/oauth-url', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { brandId, redirectUri } = req.query;

    if (!brandId || typeof brandId !== 'string') {
      res.status(400).json({ error: 'brandId query parameter is required' });
      return;
    }

    const brand = await prisma.brand.findFirst({
      where: {
        id: brandId,
        business: { tenantId: req.user?.tenantId! }
      }
    });

    if (!brand) {
      res.status(404).json({ error: 'Target brand not found or does not belong to your organization' });
      return;
    }

    // Generate unique nonce and store persistently in PostgreSQL for replay protection
    const nonce = crypto.randomBytes(16).toString('hex');
    await prisma.oAuthState.create({
      data: {
        nonce,
        userId: req.user?.id!,
        tenantId: req.user?.tenantId!,
        brandId,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000)
      }
    });

    const { oauthUrl, state } = LinkedInService.getAuthorizationUrl(
      req.user?.id!,
      req.user?.tenantId!,
      brandId,
      undefined,
      nonce,
      typeof redirectUri === 'string' ? redirectUri : undefined
    );

    res.json({
      success: true,
      oauthUrl,
      state,
      platform: 'LINKEDIN',
      clientId: config.linkedin.clientId
    });
  } catch (err: any) {
    console.error('LinkedIn get OAuth URL error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate LinkedIn OAuth URL' });
  }
});

/**
 * 2. Handle LinkedIn OAuth Callback & Persist Encrypted Account
 */
router.post('/oauth-callback', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { code, state, redirectUri } = req.body;

    if (!code) {
      res.status(400).json({ error: 'Authorization code is required' });
      return;
    }

    if (!state) {
      res.status(400).json({ error: 'OAuth state is required for CSRF validation' });
      return;
    }

    // 1. Verify CSRF state signature
    let statePayload: { userId: string; tenantId: string; brandId: string; nonce: string; ts: number };
    try {
      statePayload = CryptoService.verifyOAuthState(state);
    } catch (stateErr: any) {
      res.status(403).json({ error: `CSRF State validation failed: ${stateErr.message}` });
      return;
    }

    if (statePayload.tenantId !== req.user?.tenantId) {
      res.status(403).json({ error: 'Tenant mismatch in OAuth state' });
      return;
    }

    if (statePayload.userId !== req.user?.id) {
      res.status(403).json({ error: 'User mismatch in OAuth state' });
      return;
    }

    // 2. Consume nonce exactly once
    const consumed = await prisma.oAuthState.updateMany({
      where: {
        nonce: statePayload.nonce,
        isConsumed: false,
        expiresAt: { gt: new Date() },
        userId: req.user?.id!,
        tenantId: req.user?.tenantId!,
        brandId: statePayload.brandId
      },
      data: {
        isConsumed: true,
        consumedAt: new Date()
      }
    });

    if (consumed.count === 0) {
      res.status(403).json({
        error: 'OAuth state has already been consumed, expired, or is invalid (replay attack blocked)'
      });
      return;
    }

    const brand = await prisma.brand.findFirst({
      where: {
        id: statePayload.brandId,
        business: { tenantId: req.user?.tenantId! }
      }
    });

    if (!brand) {
      res.status(404).json({ error: 'Target brand not found or does not belong to your organization' });
      return;
    }

    // 3. Exchange code for Access Token
    const tokenData = await LinkedInService.exchangeCodeForToken(
      code,
      undefined,
      undefined,
      typeof redirectUri === 'string' ? redirectUri : undefined
    );

    // 4. Fetch authenticated member profile
    const profile = await LinkedInService.fetchUserProfile(tokenData.accessToken);

    // 5. Encrypt access token with AES-256-GCM
    const encryptedToken = CryptoService.encrypt(tokenData.accessToken);
    const tokenExpiresAt = new Date(Date.now() + tokenData.expiresIn * 1000);

    // 6. Upsert SocialAccount
    const existing = await prisma.socialAccount.findFirst({
      where: {
        brandId: brand.id,
        platform: 'LINKEDIN',
        platformAccountId: profile.sub
      }
    });

    let account;
    if (existing) {
      account = await prisma.socialAccount.update({
        where: { id: existing.id },
        data: {
          accountName: profile.name,
          username: profile.email || profile.name,
          profilePicUrl: profile.picture || existing.profilePicUrl,
          pageCategory: 'LinkedIn Profile',
          accessToken: encryptedToken,
          tokenExpiresAt,
          tokenStatus: 'VALID',
          isConnected: true,
          lastSyncedAt: new Date(),
          metadata: JSON.stringify({
            personUrn: profile.personUrn,
            email: profile.email,
            scope: tokenData.scope
          })
        }
      });
    } else {
      account = await prisma.socialAccount.create({
        data: {
          brandId: brand.id,
          platform: 'LINKEDIN',
          platformAccountId: profile.sub,
          accountName: profile.name,
          username: profile.email || profile.name.toLowerCase().replace(/[^a-z0-9]+/g, '.'),
          profilePicUrl: profile.picture || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&h=120&fit=crop',
          pageCategory: 'LinkedIn Profile',
          accessToken: encryptedToken,
          tokenExpiresAt,
          tokenStatus: 'VALID',
          isConnected: true,
          lastSyncedAt: new Date(),
          capabilities: JSON.stringify(['PUBLISHING', 'COMMENTS']),
          metadata: JSON.stringify({
            personUrn: profile.personUrn,
            email: profile.email,
            scope: tokenData.scope
          })
        }
      });
    }

    await AuditService.record({
      tenantId: req.user?.tenantId,
      userId: req.user?.id,
      action: 'LINKEDIN_ACCOUNT_CONNECTED',
      entityType: 'SocialAccount',
      entityId: account.id,
      details: {
        brandName: brand.name,
        accountName: profile.name,
        personUrn: profile.personUrn
      }
    });

    res.json({
      success: true,
      message: `Successfully connected LinkedIn account "${profile.name}"`,
      account: sanitizeAccount(account)
    });
  } catch (err: any) {
    console.error('LinkedIn OAuth callback error:', err);
    res.status(500).json({ error: err.message || 'LinkedIn OAuth callback processing failed' });
  }
});

/**
 * 3. Direct/Manual Connect with a LinkedIn Access Token (useful for developer tokens or BYOK)
 */
router.post('/connect-direct', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { brandId, accessToken, accountNameCustom, personUrnCustom } = req.body;

    if (!brandId || !accessToken) {
      res.status(400).json({ error: 'brandId and accessToken are required' });
      return;
    }

    const brand = await prisma.brand.findFirst({
      where: {
        id: brandId,
        business: { tenantId: req.user?.tenantId! }
      }
    });

    if (!brand) {
      res.status(404).json({ error: 'Target brand not found or does not belong to your organization' });
      return;
    }

    let profile: { sub: string; name: string; picture?: string; email?: string; personUrn: string };
    try {
      profile = await LinkedInService.fetchUserProfile(accessToken.trim());
    } catch {
      // Fallback if userinfo is not accessible or custom token
      const customSub = `li_${Date.now()}`;
      profile = {
        sub: customSub,
        name: accountNameCustom || 'LinkedIn Professional Profile',
        picture: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&h=120&fit=crop',
        personUrn: personUrnCustom || `urn:li:person:${customSub}`
      };
    }

    const encryptedToken = CryptoService.encrypt(accessToken.trim());

    const account = await prisma.socialAccount.create({
      data: {
        brandId: brand.id,
        platform: 'LINKEDIN',
        platformAccountId: profile.sub,
        accountName: accountNameCustom || profile.name,
        username: profile.email || profile.name.toLowerCase().replace(/[^a-z0-9]+/g, '.'),
        profilePicUrl: profile.picture,
        pageCategory: 'LinkedIn Profile',
        accessToken: encryptedToken,
        tokenExpiresAt: new Date(Date.now() + 60 * 86400 * 1000),
        tokenStatus: 'VALID',
        isConnected: true,
        lastSyncedAt: new Date(),
        capabilities: JSON.stringify(['PUBLISHING', 'COMMENTS']),
        metadata: JSON.stringify({
          personUrn: profile.personUrn,
          isDirectConnect: true
        })
      }
    });

    await AuditService.record({
      tenantId: req.user?.tenantId,
      userId: req.user?.id,
      action: 'LINKEDIN_ACCOUNT_CONNECTED',
      entityType: 'SocialAccount',
      entityId: account.id,
      details: {
        brandName: brand.name,
        accountName: account.accountName,
        method: 'DIRECT_TOKEN'
      }
    });

    res.json({
      success: true,
      message: `LinkedIn account "${account.accountName}" connected successfully`,
      account: sanitizeAccount(account)
    });
  } catch (err: any) {
    console.error('LinkedIn direct connect error:', err);
    res.status(500).json({ error: err.message || 'Failed to connect LinkedIn account' });
  }
});

/**
 * 4. Dedicated LinkedIn Test Post Dispatch
 */
router.post('/publish', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { accountId, caption, mediaUrl } = req.body;

    if (!accountId || !caption) {
      res.status(400).json({ error: 'accountId and caption are required' });
      return;
    }

    const account = await prisma.socialAccount.findFirst({
      where: {
        id: accountId,
        platform: 'LINKEDIN',
        brand: { business: { tenantId: req.user?.tenantId! } }
      }
    });

    if (!account) {
      res.status(404).json({ error: 'LinkedIn account not found or not owned by your organization' });
      return;
    }

    const rawToken = CryptoService.isEncrypted(account.accessToken)
      ? CryptoService.decrypt(account.accessToken)
      : account.accessToken;

    const metadata = account.metadata ? JSON.parse(account.metadata) : {};
    const authorUrn = metadata.personUrn || `urn:li:person:${account.platformAccountId}`;

    const result = await LinkedInService.publishPost(
      authorUrn,
      rawToken,
      caption,
      mediaUrl
    );

    res.json(result);
  } catch (err: any) {
    console.error('LinkedIn publish error:', err);
    res.status(500).json({ error: err.message || 'LinkedIn publish failed' });
  }
});

export default router;

