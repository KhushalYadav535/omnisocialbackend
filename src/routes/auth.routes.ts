import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../services/db.service';
import { authenticateToken, AuthRequest } from '../middleware/auth.middleware';
import { AuditService } from '../services/audit.service';

const router = Router();

// Login (Supports Super Admin, Tenant Admin, Team Member, Viewer)
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();

    // 1. Query regular Users table
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: {
        tenant: {
          include: {
            subscriptionPlan: true
          }
        }
      }
    });

    if (user) {
      // Security Check: Verify account is active
      if (!user.isActive) {
        res.status(403).json({ error: 'Account has been deactivated. Please contact your organization administrator.' });
        return;
      }

      // Security Check: If associated with tenant, check tenant status
      if (user.tenant && user.tenant.status !== 'ACTIVE') {
        res.status(403).json({ error: 'Organization account is currently inactive or suspended.' });
        return;
      }

      // Security Fix: STRICT password verification using bcrypt only. NO bypass.
      const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
      if (!isPasswordValid) {
        res.status(401).json({ error: 'Invalid email or password' });
        return;
      }

      // Update last login timestamp asynchronously
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() }
      }).catch(err => console.error('Failed to update lastLoginAt:', err));

      const token = jwt.sign(
        {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: user.tenantId || null
        },
        config.jwtSecret,
        { expiresIn: '7d' }
      );

      await AuditService.record({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'AUTH_LOGIN',
        entityType: 'User',
        entityId: user.id,
        details: { email: user.email, role: user.role }
      });

      res.json({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          avatarUrl: user.avatarUrl,
          tenantId: user.tenantId
        },
        tenant: user.tenant ? {
          id: user.tenant.id,
          name: user.tenant.name,
          slug: user.tenant.slug,
          status: user.tenant.status,
          plan: user.tenant.subscriptionPlan?.name,
          hasCustomKeys: !!(user.tenant.customMetaAppId || user.tenant.customAiApiKey)
        } : null
      });
      return;
    }

    // 2. Query SuperAdmin table
    const superAdmin = await prisma.superAdmin.findUnique({
      where: { email: normalizedEmail }
    });

    if (superAdmin) {
      // Security Fix: STRICT password verification using bcrypt only. NO bypass.
      const isPasswordValid = await bcrypt.compare(password, superAdmin.passwordHash);
      if (!isPasswordValid) {
        res.status(401).json({ error: 'Invalid email or password' });
        return;
      }

      const token = jwt.sign(
        {
          id: superAdmin.id,
          email: superAdmin.email,
          name: superAdmin.name,
          role: 'SUPER_ADMIN',
          tenantId: null
        },
        config.jwtSecret,
        { expiresIn: '7d' }
      );

      await AuditService.record({
        tenantId: null,
        userId: superAdmin.id,
        action: 'AUTH_SUPERADMIN_LOGIN',
        entityType: 'SuperAdmin',
        entityId: superAdmin.id,
        details: { email: superAdmin.email }
      });

      res.json({
        token,
        user: {
          id: superAdmin.id,
          email: superAdmin.email,
          name: superAdmin.name,
          role: 'SUPER_ADMIN',
          avatarUrl: null,
          tenantId: null
        },
        tenant: null
      });
      return;
    }

    res.status(401).json({ error: 'Invalid email or password' });
    return;
  } catch (err: any) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message || 'Login failed' });
    return;
  }
});

// Register new Tenant (Self-serve or invite onboarding)
router.post('/register-tenant', async (req: Request, res: Response): Promise<void> => {
  try {
    const { tenantName, adminName, email, password, planCode = 'FREE_TRIAL' } = req.body;

    if (!tenantName || !adminName || !email || !password) {
      res.status(400).json({ error: 'All fields are required' });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if user or super admin already exists with this email
    const [existingUser, existingSuperAdmin] = await Promise.all([
      prisma.user.findUnique({ where: { email: normalizedEmail } }),
      prisma.superAdmin.findUnique({ where: { email: normalizedEmail } })
    ]);

    if (existingUser || existingSuperAdmin) {
      res.status(400).json({ error: 'A user account with this email address already exists' });
      return;
    }

    // Resolve subscription plan
    let plan = await prisma.subscriptionPlan.findUnique({
      where: { code: planCode }
    });

    if (!plan) {
      plan = await prisma.subscriptionPlan.findFirst();
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const tenantSlug = tenantName.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Math.floor(Math.random() * 1000);

    // Atomically create Tenant, Admin User, Initial Business, Brand and Voice Profile
    const result = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: tenantName,
          slug: tenantSlug,
          status: 'ACTIVE',
          subscriptionPlanId: plan?.id || null
        }
      });

      const user = await tx.user.create({
        data: {
          email: normalizedEmail,
          passwordHash: hashedPassword,
          name: adminName,
          role: 'TENANT_ADMIN',
          avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&h=120&fit=crop',
          isActive: true,
          tenantId: tenant.id
        }
      });

      const business = await tx.business.create({
        data: {
          tenantId: tenant.id,
          name: `${tenantName} Core Business`,
          legalName: tenantName,
          industry: 'E-commerce & Digital Brands',
          status: 'ACTIVE'
        }
      });

      const brand = await tx.brand.create({
        data: {
          businessId: business.id,
          name: `${tenantName} Primary Brand`,
          slug: `${tenantSlug}-primary`,
          logoUrl: 'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=120&h=120&fit=crop',
          description: 'Primary customer-facing brand for engagement and social campaigns.',
          status: 'ACTIVE'
        }
      });

      await tx.brandVoiceProfile.create({
        data: {
          brandId: brand.id,
          tone: 'Friendly, helpful, energetic, and professional',
          writingStyle: 'Modern conversational with relevant emojis',
          targetAudience: 'Digital savvy consumers and community members',
          keyTerminology: 'Premium Quality, Instant Delivery, Eco-friendly',
          bannedKeywords: 'cheap, bargain, fake',
          standardFaqs: 'Q: What are your working hours?\nA: 24/7 online support.',
          responseGuidelines: 'Always greet politely and provide prompt assistance.',
          exampleReplies: '[]'
        }
      });

      return { tenant, user, plan };
    });

    const token = jwt.sign(
      {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        role: result.user.role,
        tenantId: result.tenant.id
      },
      config.jwtSecret,
      { expiresIn: '7d' }
    );

    await AuditService.record({
      tenantId: result.tenant.id,
      userId: result.user.id,
      action: 'TENANT_REGISTERED',
      entityType: 'Tenant',
      entityId: result.tenant.id,
      details: { tenantName: result.tenant.name, email: result.user.email }
    });

    res.status(201).json({
      token,
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        role: result.user.role,
        tenantId: result.tenant.id
      },
      tenant: {
        id: result.tenant.id,
        name: result.tenant.name,
        slug: result.tenant.slug,
        plan: result.plan?.name
      }
    });
    return;
  } catch (err: any) {
    console.error('Registration error:', err);
    res.status(500).json({ error: err.message || 'Tenant registration failed' });
    return;
  }
});

// Get Current User Profile & Context
router.get('/me', authenticateToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (req.user.tenantId) {
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        include: { subscriptionPlan: true }
      });

      res.json({
        user: req.user,
        tenant: tenant ? {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          status: tenant.status,
          plan: tenant.subscriptionPlan?.name,
          planCode: tenant.subscriptionPlan?.code,
          hasCustomKeys: !!(tenant.customMetaAppId || tenant.customAiApiKey)
        } : null
      });
      return;
    }

    res.json({
      user: req.user,
      tenant: null
    });
    return;
  } catch (err: any) {
    console.error('/me error:', err);
    res.status(500).json({ error: err.message || 'Failed to retrieve profile' });
    return;
  }
});

export default router;
