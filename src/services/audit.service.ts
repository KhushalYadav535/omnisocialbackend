import { prisma } from './db.service';

export interface CreateAuditInput {
  tenantId?: string | null;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: any;
  ipAddress?: string;
}

export class AuditService {
  static async record(input: CreateAuditInput) {
    try {
      const detailsStr = typeof input.details === 'string'
        ? input.details
        : JSON.stringify(input.details || {});

      // Verify tenantId exists before referencing to satisfy foreign key constraints
      let validTenantId: string | null = null;
      if (input.tenantId) {
        const tenantExists = await prisma.tenant.findUnique({
          where: { id: input.tenantId },
          select: { id: true }
        });
        if (tenantExists) {
          validTenantId = tenantExists.id;
        }
      }

      // Verify userId exists before referencing to satisfy foreign key constraints
      let validUserId: string | null = null;
      if (input.userId) {
        const userExists = await prisma.user.findUnique({
          where: { id: input.userId },
          select: { id: true }
        });
        if (userExists) {
          validUserId = userExists.id;
        }
      }

      const event = await prisma.auditEvent.create({
        data: {
          tenantId: validTenantId,
          userId: validUserId,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId || null,
          details: detailsStr,
          ipAddress: input.ipAddress || '127.0.0.1'
        }
      });

      return event;
    } catch (error) {
      console.error('AuditService.record error:', error);
      // Non-blocking fallback so audit logging failures don't crash main application requests
      return null;
    }
  }
}
