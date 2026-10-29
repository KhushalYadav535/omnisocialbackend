import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth.middleware';

export type Role =
  | 'SUPER_ADMIN'
  | 'OWNER'
  | 'ADMIN'
  | 'TENANT_ADMIN'
  | 'EDITOR'
  | 'APPROVER'
  | 'ANALYST'
  | 'TEAM_MEMBER'
  | 'VIEWER';

export type Permission =
  | 'VIEW_ANALYTICS'
  | 'CREATE_CONTENT'
  | 'EDIT_CONTENT'
  | 'SCHEDULE_POSTS'
  | 'APPROVE_CONTENT'
  | 'PUBLISH_IMMEDIATELY'
  | 'MANAGE_TEAM'
  | 'CONNECT_ACCOUNTS'
  | 'CHANGE_SETTINGS'
  | 'EXPORT_DATA';

export const PERMISSION_MATRIX: Record<Permission, Role[]> = {
  VIEW_ANALYTICS: [
    'SUPER_ADMIN',
    'OWNER',
    'ADMIN',
    'TENANT_ADMIN',
    'EDITOR',
    'APPROVER',
    'ANALYST',
    'TEAM_MEMBER',
    'VIEWER'
  ],
  CREATE_CONTENT: [
    'SUPER_ADMIN',
    'OWNER',
    'ADMIN',
    'TENANT_ADMIN',
    'EDITOR',
    'TEAM_MEMBER'
  ],
  EDIT_CONTENT: [
    'SUPER_ADMIN',
    'OWNER',
    'ADMIN',
    'TENANT_ADMIN',
    'EDITOR',
    'TEAM_MEMBER'
  ],
  SCHEDULE_POSTS: [
    'SUPER_ADMIN',
    'OWNER',
    'ADMIN',
    'TENANT_ADMIN',
    'EDITOR',
    'APPROVER',
    'TEAM_MEMBER'
  ],
  APPROVE_CONTENT: [
    'SUPER_ADMIN',
    'OWNER',
    'ADMIN',
    'TENANT_ADMIN',
    'APPROVER'
  ],
  PUBLISH_IMMEDIATELY: [
    'SUPER_ADMIN',
    'OWNER',
    'ADMIN',
    'TENANT_ADMIN',
    'APPROVER'
  ],
  MANAGE_TEAM: [
    'SUPER_ADMIN',
    'OWNER',
    'ADMIN',
    'TENANT_ADMIN'
  ],
  CONNECT_ACCOUNTS: [
    'SUPER_ADMIN',
    'OWNER',
    'ADMIN',
    'TENANT_ADMIN'
  ],
  CHANGE_SETTINGS: [
    'SUPER_ADMIN',
    'OWNER',
    'ADMIN',
    'TENANT_ADMIN'
  ],
  EXPORT_DATA: [
    'SUPER_ADMIN',
    'OWNER',
    'ADMIN',
    'TENANT_ADMIN',
    'ANALYST',
    'VIEWER'
  ]
};

// Hierarchy level for privilege escalation prevention
const ROLE_HIERARCHY: Record<Role, number> = {
  SUPER_ADMIN: 100,
  OWNER: 90,
  TENANT_ADMIN: 80,
  ADMIN: 80,
  APPROVER: 60,
  EDITOR: 50,
  TEAM_MEMBER: 50,
  ANALYST: 30,
  VIEWER: 30
};

export function canPerformAction(userRole: string, permission: Permission): boolean {
  const allowedRoles = PERMISSION_MATRIX[permission] || [];
  return allowedRoles.includes(userRole as Role);
}

/**
 * Ensures an actor cannot grant permissions or roles equal or higher than their own level.
 */
export function canAssignRole(actorRole: string, targetRole: string): boolean {
  if (actorRole === 'SUPER_ADMIN') return true;
  const actorLevel = ROLE_HIERARCHY[actorRole as Role] || 0;
  const targetLevel = ROLE_HIERARCHY[targetRole as Role] || 0;

  // Cannot assign OWNER unless SUPER_ADMIN or already OWNER
  if (targetRole === 'OWNER' && actorRole !== 'OWNER') return false;

  return actorLevel > targetLevel || (actorRole === 'OWNER' && actorLevel >= targetLevel);
}

/**
 * Express middleware to enforce explicit server-side RBAC permissions
 */
export const requirePermission = (permission: Permission) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized: authentication token required' });
      return;
    }

    if (!canPerformAction(req.user.role, permission)) {
      res.status(403).json({
        error: `Access denied: role '${req.user.role}' lacks '${permission}' permission`,
        permissionRequired: permission,
        userRole: req.user.role
      });
      return;
    }

    next();
  };
};

