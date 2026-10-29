import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../services/db.service';
import { OpenRouterService } from '../services/openrouter.service';
import { config } from '../config';
import { authenticateToken, requireTenant, requireRole, AuthRequest } from '../middleware/auth.middleware';
import { AuditService } from '../services/audit.service';

const router = Router();

router.use(authenticateToken);
router.use(requireTenant);

// 1. Get Current Tenant Settings
router.get('/settings', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.tenantId) {
      res.status(400).json({ error: 'Tenant context is missing' });
      return;
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      include: { subscriptionPlan: true }
    });

    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }

    res.json({
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        domain: tenant.domain,
        status: tenant.status,
        customMetaAppId: tenant.customMetaAppId,
        hasCustomMetaAppSecret: !!tenant.customMetaAppSecret,
        aiProvisioning: {
          isPlatformManaged: true,
          gateway: 'OpenRouter (Central Platform Managed)',
          isConfigured: OpenRouterService.isConfigured(),
          models: {
            reply: config.openrouter.replyModel,
            content: config.openrouter.contentModel,
            classification: config.openrouter.classificationModel
          }
        }
      },
      plan: tenant.subscriptionPlan
    });
  } catch (err: any) {
    console.error('Tenant settings error:', err);
    res.status(500).json({ error: err.message || 'Failed to retrieve tenant settings' });
  }
});

// 2. Update Tenant BYOK Settings (Only Tenant Admin or Super Admin)
router.patch('/settings', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { customMetaAppId, customMetaAppSecret, name, domain } = req.body;
    const tenantId = req.user?.tenantId;

    if (!tenantId) {
      res.status(400).json({ error: 'Tenant context is missing' });
      return;
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId }
    });

    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }

    const updateData: any = {};
    if (name) updateData.name = name;
    if (domain !== undefined) updateData.domain = domain;
    if (customMetaAppId !== undefined) updateData.customMetaAppId = customMetaAppId;
    if (customMetaAppSecret !== undefined && customMetaAppSecret.trim()) updateData.customMetaAppSecret = customMetaAppSecret;

    const updated = await prisma.tenant.update({
      where: { id: tenantId },
      data: updateData
    });

    await AuditService.record({
      tenantId: updated.id,
      userId: req.user?.id,
      action: 'TENANT_UPDATED_SETTINGS',
      entityType: 'Tenant',
      entityId: updated.id,
      details: { hasCustomMeta: !!updated.customMetaAppId }
    });

    res.json({
      success: true,
      message: 'Tenant settings and Meta credentials updated successfully. AI is managed centrally by the platform.',
      tenant: {
        id: updated.id,
        name: updated.name,
        customMetaAppId: updated.customMetaAppId,
        hasCustomMetaAppSecret: !!updated.customMetaAppSecret,
        aiProvisioning: {
          isPlatformManaged: true,
          gateway: 'OpenRouter (Central Platform Managed)',
          isConfigured: OpenRouterService.isConfigured()
        }
      }
    });
  } catch (err: any) {
    console.error('Update tenant settings error:', err);
    res.status(500).json({ error: err.message || 'Failed to update tenant settings' });
  }
});

// 3. Team Members List
router.get('/team', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const team = await prisma.user.findMany({
      where: { tenantId: req.user?.tenantId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        avatarUrl: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ team });
  } catch (err: any) {
    console.error('List team error:', err);
    res.status(500).json({ error: err.message || 'Failed to list team members' });
  }
});

// 4. Invite / Add Team Member
router.post('/team/invite', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { email, name, role = 'TEAM_MEMBER', temporaryPassword = 'Password123!' } = req.body;

    if (!email || !name) {
      res.status(400).json({ error: 'Email and name are required' });
      return;
    }

    if (!req.user?.tenantId) {
      res.status(400).json({ error: 'Tenant context is missing' });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if user already exists
    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail }
    });

    if (existing) {
      res.status(400).json({ error: 'User with this email already exists' });
      return;
    }

    const hashedPassword = await bcrypt.hash(temporaryPassword, 10);
    const newUser = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash: hashedPassword,
        name,
        role,
        avatarUrl: `https://images.unsplash.com/photo-${1500000000000 + Math.floor(Math.random() * 100000)}?w=120&h=120&fit=crop`,
        isActive: true,
        tenantId: req.user.tenantId
      }
    });

    await AuditService.record({
      tenantId: req.user.tenantId,
      userId: req.user.id,
      action: 'TEAM_MEMBER_INVITED',
      entityType: 'User',
      entityId: newUser.id,
      details: { email: normalizedEmail, role }
    });

    res.status(201).json({
      success: true,
      message: `Team member ${name} invited successfully`,
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
        isActive: newUser.isActive
      }
    });
  } catch (err: any) {
    console.error('Invite team member error:', err);
    res.status(500).json({ error: err.message || 'Failed to invite team member' });
  }
});

// 5. Deactivate / Remove Team Member
router.delete('/team/:userId', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawUserId = req.params.userId;
    const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;

    if (userId === req.user?.id) {
      res.status(400).json({ error: 'You cannot deactivate your own account' });
      return;
    }

    const user = await prisma.user.findFirst({
      where: {
        id: userId,
        tenantId: req.user?.tenantId
      }
    });

    if (!user) {
      res.status(404).json({ error: 'Team member not found or does not belong to your organization' });
      return;
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { isActive: false }
    });

    await AuditService.record({
      tenantId: req.user?.tenantId,
      userId: req.user?.id,
      action: 'TEAM_MEMBER_DEACTIVATED',
      entityType: 'User',
      entityId: user.id,
      details: { email: user.email }
    });

    res.json({ success: true, message: `User ${updated.name} has been deactivated` });
  } catch (err: any) {
    console.error('Deactivate team member error:', err);
    res.status(500).json({ error: err.message || 'Failed to deactivate team member' });
  }
});

export default router;
