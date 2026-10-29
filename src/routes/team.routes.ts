import { Router, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../services/db.service';
import { config } from '../config';
import { authenticateToken, requireTenant, AuthRequest } from '../middleware/auth.middleware';
import { requirePermission, canAssignRole, Role } from '../middleware/rbac.middleware';
import { AuditService } from '../services/audit.service';

const router = Router();

// =====================================================================
// Public Endpoint: Accept Invitation
// =====================================================================
router.post('/accept-invite', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { invitationToken, name, password } = req.body;

    if (!invitationToken || !password) {
      res.status(400).json({ error: 'invitationToken and password are required' });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters long' });
      return;
    }

    // Compute SHA-256 hash of provided token
    const tokenHash = crypto.createHash('sha256').update(invitationToken.trim()).digest('hex');

    const invitation = await prisma.teamInvitation.findUnique({
      where: { tokenHash },
      include: { tenant: true }
    });

    if (!invitation) {
      res.status(404).json({ error: 'Invalid invitation token' });
      return;
    }

    if (invitation.isAccepted) {
      res.status(400).json({ error: 'This invitation has already been accepted' });
      return;
    }

    if (invitation.isRevoked) {
      res.status(400).json({ error: 'This invitation has been revoked by an administrator' });
      return;
    }

    if (invitation.expiresAt < new Date()) {
      res.status(400).json({ error: 'This invitation has expired. Please request a new invitation.' });
      return;
    }

    if (invitation.tenant.status !== 'ACTIVE') {
      res.status(403).json({ error: 'The organization associated with this invitation is suspended or inactive' });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const existingUser = await prisma.user.findUnique({
      where: { email: invitation.email }
    });

    let user: any;

    if (existingUser) {
      // Prevent cross-tenant acceptance if already associated with a different active tenant
      if (existingUser.tenantId && existingUser.tenantId !== invitation.tenantId) {
        res.status(403).json({
          error: 'This email is already registered to another organization. Cross-tenant invitation acceptance is forbidden.'
        });
        return;
      }

      // Update existing user with tenant and role
      user = await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          tenantId: invitation.tenantId,
          role: invitation.role,
          name: name?.trim() || existingUser.name,
          passwordHash: hashedPassword,
          isActive: true
        }
      });
    } else {
      // Create brand new user
      user = await prisma.user.create({
        data: {
          email: invitation.email,
          name: name?.trim() || invitation.email.split('@')[0],
          passwordHash: hashedPassword,
          role: invitation.role,
          tenantId: invitation.tenantId,
          isActive: true
        }
      });
    }

    // Mark invitation accepted
    await prisma.teamInvitation.update({
      where: { id: invitation.id },
      data: {
        isAccepted: true,
        acceptedAt: new Date()
      }
    });

    await AuditService.record({
      tenantId: invitation.tenantId,
      userId: user.id,
      action: 'TEAM_INVITATION_ACCEPTED',
      entityType: 'TeamInvitation',
      entityId: invitation.id,
      details: { email: invitation.email, role: invitation.role }
    });

    // Generate JWT token for immediate login
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        tenantId: user.tenantId
      },
      config.jwtSecret,
      { expiresIn: '7d' }
    );

    res.status(200).json({
      success: true,
      message: `Welcome to ${invitation.tenant.name}! Your account has been activated.`,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        tenantId: user.tenantId,
        tenantName: invitation.tenant.name
      }
    });
  } catch (err: any) {
    console.error('Accept invitation error:', err);
    res.status(500).json({ error: err.message || 'Failed to accept invitation' });
  }
});

// =====================================================================
// Authenticated & Tenant-Scoped Team Management Endpoints
// =====================================================================
router.use(authenticateToken);
router.use(requireTenant);

// 1. List Team Members
router.get('/', requirePermission('VIEW_ANALYTICS'), async (req: AuthRequest, res: Response): Promise<void> => {
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

// 2. List Pending Invitations
router.get('/invitations', requirePermission('MANAGE_TEAM'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const invitations = await prisma.teamInvitation.findMany({
      where: {
        tenantId: req.user?.tenantId!,
        isAccepted: false,
        isRevoked: false
      },
      select: {
        id: true,
        email: true,
        role: true,
        expiresAt: true,
        createdAt: true,
        invitedBy: {
          select: { id: true, name: true, email: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ invitations });
  } catch (err: any) {
    console.error('List invitations error:', err);
    res.status(500).json({ error: err.message || 'Failed to list invitations' });
  }
});

// 3. Create Cryptographically Secure Single-Use Invitation
router.post('/invite', requirePermission('MANAGE_TEAM'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { email, role = 'EDITOR', expiresInDays = 7 } = req.body;

    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();
    const callerRole = req.user?.role!;

    // Privilege escalation check: cannot invite someone to a higher or equal role
    if (!canAssignRole(callerRole, role)) {
      res.status(403).json({
        error: `Privilege escalation blocked: your role '${callerRole}' cannot assign role '${role}'`
      });
      return;
    }

    // Check if user is already an active member of this tenant
    const existingMember = await prisma.user.findFirst({
      where: {
        email: normalizedEmail,
        tenantId: req.user?.tenantId,
        isActive: true
      }
    });

    if (existingMember) {
      res.status(400).json({ error: 'User is already an active member of your organization' });
      return;
    }

    // Invalidate any older pending invitations for this email in this tenant
    await prisma.teamInvitation.updateMany({
      where: {
        tenantId: req.user?.tenantId!,
        email: normalizedEmail,
        isAccepted: false,
        isRevoked: false
      },
      data: {
        isRevoked: true,
        revokedAt: new Date()
      }
    });

    // Generate cryptographically random 32-byte single-use invitation token
    const rawInvitationToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawInvitationToken).digest('hex');
    const expiresAt = new Date(Date.now() + Number(expiresInDays) * 24 * 60 * 60 * 1000);

    const invitation = await prisma.teamInvitation.create({
      data: {
        tenantId: req.user?.tenantId!,
        email: normalizedEmail,
        role,
        tokenHash,
        invitedById: req.user?.id!,
        expiresAt
      }
    });

    await AuditService.record({
      tenantId: req.user?.tenantId,
      userId: req.user?.id,
      action: 'TEAM_INVITATION_CREATED',
      entityType: 'TeamInvitation',
      entityId: invitation.id,
      details: { email: normalizedEmail, role, expiresAt: expiresAt.toISOString() }
    });

    res.status(201).json({
      success: true,
      message: `Invitation generated successfully for ${normalizedEmail}`,
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
        invitationToken: rawInvitationToken,
        invitationUrl: `/team/accept?token=${rawInvitationToken}`
      }
    });
  } catch (err: any) {
    console.error('Create invitation error:', err);
    res.status(500).json({ error: err.message || 'Failed to create invitation' });
  }
});

// 4. Revoke Pending Invitation
router.delete('/invitations/:id', requirePermission('MANAGE_TEAM'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;

    const invitation = await prisma.teamInvitation.findFirst({
      where: {
        id,
        tenantId: req.user?.tenantId!
      }
    });

    if (!invitation) {
      res.status(404).json({ error: 'Invitation not found or not owned by your organization' });
      return;
    }

    if (invitation.isAccepted) {
      res.status(400).json({ error: 'Cannot revoke an invitation that has already been accepted' });
      return;
    }

    const updated = await prisma.teamInvitation.update({
      where: { id },
      data: {
        isRevoked: true,
        revokedAt: new Date()
      }
    });

    await AuditService.record({
      tenantId: req.user?.tenantId,
      userId: req.user?.id,
      action: 'TEAM_INVITATION_REVOKED',
      entityType: 'TeamInvitation',
      entityId: updated.id,
      details: { email: updated.email }
    });

    res.json({ success: true, message: `Invitation for ${updated.email} has been revoked` });
  } catch (err: any) {
    console.error('Revoke invitation error:', err);
    res.status(500).json({ error: err.message || 'Failed to revoke invitation' });
  }
});

// 5. Update Team Member Role
router.patch('/:userId/role', requirePermission('MANAGE_TEAM'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawUserId = req.params.userId;
    const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;
    const { newRole } = req.body;

    if (!newRole) {
      res.status(400).json({ error: 'newRole is required' });
      return;
    }

    const callerRole = req.user?.role!;

    // Privilege escalation check
    if (!canAssignRole(callerRole, newRole)) {
      res.status(403).json({
        error: `Privilege escalation blocked: your role '${callerRole}' cannot assign role '${newRole}'`
      });
      return;
    }

    const targetUser = await prisma.user.findFirst({
      where: { id: userId, tenantId: req.user?.tenantId! }
    });

    if (!targetUser) {
      res.status(404).json({ error: 'Team member not found' });
      return;
    }

    // Prevent demoting the last OWNER
    if (targetUser.role === 'OWNER' && newRole !== 'OWNER') {
      const ownerCount = await prisma.user.count({
        where: { tenantId: req.user?.tenantId!, role: 'OWNER', isActive: true }
      });
      if (ownerCount <= 1) {
        res.status(400).json({ error: 'Cannot demote the only remaining Organization Owner' });
        return;
      }
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { role: newRole }
    });

    await AuditService.record({
      tenantId: req.user?.tenantId,
      userId: req.user?.id,
      action: 'TEAM_MEMBER_ROLE_CHANGED',
      entityType: 'User',
      entityId: updated.id,
      details: { previousRole: targetUser.role, newRole: updated.role, email: updated.email }
    });

    res.json({
      success: true,
      message: `Updated role for ${updated.name} to ${updated.role}`,
      user: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role
      }
    });
  } catch (err: any) {
    console.error('Update member role error:', err);
    res.status(500).json({ error: err.message || 'Failed to update member role' });
  }
});

// 6. Deactivate Team Member
router.delete('/:userId', requirePermission('MANAGE_TEAM'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawUserId = req.params.userId;
    const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;

    if (userId === req.user?.id) {
      res.status(400).json({ error: 'You cannot deactivate your own account' });
      return;
    }

    const targetUser = await prisma.user.findFirst({
      where: { id: userId, tenantId: req.user?.tenantId! }
    });

    if (!targetUser) {
      res.status(404).json({ error: 'Team member not found' });
      return;
    }

    if (targetUser.role === 'OWNER' && req.user?.role !== 'SUPER_ADMIN' && req.user?.role !== 'OWNER') {
      res.status(403).json({ error: 'Only Organization Owners can deactivate another Owner' });
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
      entityId: targetUser.id,
      details: { email: targetUser.email, name: targetUser.name }
    });

    res.json({ success: true, message: `Team member ${updated.name} has been deactivated` });
  } catch (err: any) {
    console.error('Deactivate team member error:', err);
    res.status(500).json({ error: err.message || 'Failed to deactivate team member' });
  }
});

export default router;

