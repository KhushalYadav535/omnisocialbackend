import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'AUDIT';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  correlationId?: string;
  tenantId?: string | null;
  userId?: string | null;
  operation: string;
  durationMs?: number;
  errorCategory?: string;
  message: string;
  metadata?: Record<string, any>;
}

export class LoggerService {
  private static sensitiveKeys = [
    'password',
    'passwordhash',
    'token',
    'accesstoken',
    'encryptedaccesstoken',
    'secret',
    'appsecret',
    'key',
    'encryptionkey',
    'authorization',
    'cookie',
    'signature'
  ];

  /**
   * Sanitizes object payloads recursively to ensure credentials and tokens never leak into logs.
   */
  static sanitize(obj: any): any {
    if (obj === null || obj === undefined) return obj;

    if (typeof obj === 'string') {
      // Redact Meta access tokens
      let sanitized = obj.replace(/EAAB[a-zA-Z0-9]+/g, 'EAAB***[REDACTED]');
      // Redact Bearer tokens
      sanitized = sanitized.replace(/Bearer\s+[a-zA-Z0-9\-_.]+/gi, 'Bearer ***[REDACTED]');
      return sanitized;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.sanitize(item));
    }

    if (typeof obj === 'object') {
      const sanitizedObj: Record<string, any> = {};
      for (const [key, value] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();
        if (this.sensitiveKeys.some(sensitive => lowerKey.includes(sensitive))) {
          sanitizedObj[key] = '***[REDACTED]***';
        } else {
          sanitizedObj[key] = this.sanitize(value);
        }
      }
      return sanitizedObj;
    }

    return obj;
  }

  private static emit(entry: LogEntry) {
    const sanitizedMeta = entry.metadata ? this.sanitize(entry.metadata) : undefined;
    const sanitizedMsg = this.sanitize(entry.message);

    const logPayload = {
      ...entry,
      message: sanitizedMsg,
      metadata: sanitizedMeta
    };

    const formattedJson = JSON.stringify(logPayload);

    switch (entry.level) {
      case 'ERROR':
        console.error(`🔴 [ERROR] ${formattedJson}`);
        break;
      case 'WARN':
        console.warn(`🟡 [WARN] ${formattedJson}`);
        break;
      case 'AUDIT':
        console.log(`🛡️ [AUDIT] ${formattedJson}`);
        break;
      default:
        console.log(`🟢 [INFO] ${formattedJson}`);
    }
  }

  static info(operation: string, message: string, meta?: Partial<LogEntry>) {
    this.emit({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      operation,
      message,
      ...meta
    });
  }

  static warn(operation: string, message: string, meta?: Partial<LogEntry>) {
    this.emit({
      timestamp: new Date().toISOString(),
      level: 'WARN',
      operation,
      message,
      ...meta
    });
  }

  static error(operation: string, error: Error | any, meta?: Partial<LogEntry>) {
    const errorCategory = error?.name || error?.code || 'APPLICATION_ERROR';
    this.emit({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      operation,
      errorCategory,
      message: error?.message || String(error),
      metadata: {
        ...(meta?.metadata || {}),
        errorStack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
      },
      ...meta
    });
  }

  /**
   * Express middleware to attach correlation ID and log incoming requests with duration
   */
  static correlationMiddleware(req: any, res: Response, next: NextFunction) {
    const correlationId = (req.headers['x-correlation-id'] as string) || crypto.randomUUID();
    req.correlationId = correlationId;
    res.setHeader('x-correlation-id', correlationId);

    const start = Date.now();

    res.on('finish', () => {
      const durationMs = Date.now() - start;
      const tenantId = req.user?.tenantId || req.headers['x-tenant-id'] || null;

      if (res.statusCode >= 400) {
        LoggerService.warn('HTTP_REQUEST', `${req.method} ${req.originalUrl} - ${res.statusCode}`, {
          correlationId,
          tenantId,
          userId: req.user?.id,
          durationMs,
          metadata: { statusCode: res.statusCode, method: req.method, path: req.originalUrl }
        });
      } else {
        LoggerService.info('HTTP_REQUEST', `${req.method} ${req.originalUrl} - ${res.statusCode}`, {
          correlationId,
          tenantId,
          userId: req.user?.id,
          durationMs,
          metadata: { statusCode: res.statusCode, method: req.method, path: req.originalUrl }
        });
      }
    });

    next();
  }
}

