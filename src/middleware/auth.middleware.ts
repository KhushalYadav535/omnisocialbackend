import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../services/db.service';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: 'SUPER_ADMIN' | 'OWNER' | 'ADMIN' | 'TENANT_ADMIN' | 'EDITOR' | 'APPROVER' | 'ANALYST' | 'TEAM_MEMBER' | 'VIEWER';
  tenantId: string | null;
}

export interface AuthRequest extends Request {
  user?: AuthenticatedUser;
}

export const authenticateToken = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (!token) {
    res.status(401).json({ error: 'Authentication token required' });
    return;
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as {
      id: string;
      email: string;
      role: string;
      tenantId?: string | null;
    };

    // 1. Check regular Users table
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      include: { tenant: true }
    });

    if (user) {
      if (!user.isActive) {
        res.status(403).json({ error: 'Account has been deactivated' });
        return;
      }

      if (user.tenantId && user.tenant && user.tenant.status !== 'ACTIVE') {
        res.status(403).json({ error: 'Associated tenant organization is inactive or suspended' });
        return;
      }

      req.user = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role as any,
        tenantId: user.tenantId || null
      };

      next();
      return;
    }

    // 2. Check SuperAdmin table
    const superAdmin = await prisma.superAdmin.findUnique({
      where: { id: decoded.id }
    });

    if (superAdmin) {
      req.user = {
        id: superAdmin.id,
        email: superAdmin.email,
        name: superAdmin.name,
        role: 'SUPER_ADMIN',
        tenantId: null
      };

      next();
      return;
    }

    res.status(401).json({ error: 'User session invalid or user no longer exists' });
    return;
  } catch (err: any) {
    res.status(403).json({ error: 'Invalid or expired token', details: err.message });
    return;
  }
};

export const requireRole = (roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Access denied: insufficient platform privileges' });
      return;
    }

    next();
  };
};

export const requireTenant = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const requestedTenantId = req.headers['x-tenant-id'] as string | undefined;

  // Enforce strict tenant isolation: non-superadmins CANNOT override tenant via header
  if (req.user.role !== 'SUPER_ADMIN') {
    if (requestedTenantId && requestedTenantId !== req.user.tenantId) {
      res.status(403).json({ error: 'Forbidden: unauthorized cross-tenant override attempt' });
      return;
    }

    if (!req.user.tenantId) {
      res.status(400).json({ error: 'User is not associated with an active tenant' });
      return;
    }

    next();
    return;
  }

  // Super Admins can optionally scope to a specific tenant via x-tenant-id
  if (req.user.role === 'SUPER_ADMIN' && requestedTenantId) {
    req.user.tenantId = requestedTenantId;
  }

  next();
};
