import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import { prisma } from './services/db.service';
import { SchedulerService } from './services/scheduler.service';
import { CryptoService } from './services/crypto.service';

import authRoutes from './routes/auth.routes';
import superadminRoutes from './routes/superadmin.routes';
import tenantRoutes from './routes/tenant.routes';
import businessRoutes from './routes/business.routes';
import socialAccountRoutes from './routes/socialAccounts.routes';
import inboxRoutes from './routes/inbox.routes';
import aiRoutes from './routes/ai.routes';
import repliesRoutes from './routes/replies.routes';
import contentRoutes from './routes/content.routes';
import calendarRoutes from './routes/calendar.routes';
import publicationRoutes from './routes/publications.routes';
import analyticsRoutes from './routes/analytics.routes';
import webhookRoutes from './routes/webhooks.routes';
import teamRoutes from './routes/team.routes';
import monitoringRoutes from './routes/monitoring.routes';
import { LoggerService } from './services/logger.service';

const app = express();

// Middlewares
app.use(LoggerService.correlationMiddleware);
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-tenant-id']
}));
app.use(express.json({
  limit: '10mb',
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({
  extended: true,
  limit: '10mb',
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  }
}));

// Static media uploads serving
const uploadsDirectory = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDirectory)) {
  fs.mkdirSync(uploadsDirectory, { recursive: true });
}
app.use('/uploads', express.static(uploadsDirectory));

// Health Check with Database Connectivity Status
app.get('/api/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'ONLINE',
      version: '1.0.0',
      database: 'CONNECTED',
      service: 'AI Social Media Management Engine',
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    res.status(503).json({
      status: 'DEGRADED',
      database: 'DISCONNECTED',
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Route Mounting
app.use('/api/webhooks', webhookRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/superadmin', superadminRoutes);
app.use('/api/tenant', tenantRoutes);
app.use('/api/social-accounts', socialAccountRoutes);
app.use('/api/inbox', inboxRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/replies', repliesRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/publications', publicationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/monitoring', monitoringRoutes);
app.use('/api', businessRoutes);

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  LoggerService.error('UNHANDLED_EXCEPTION', err, {
    correlationId: (req as any).correlationId,
    tenantId: (req as any).user?.tenantId
  });
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message || 'An unexpected error occurred'
  });
});

// Start Server
async function start() {
  try {
    // 1. Fail closed if cryptographic keys or secrets are missing/invalid
    CryptoService.validateStartupConfiguration();
    console.log('🔒 Cryptographic security configuration validated (AES-256-GCM + HMAC-SHA256)');

    // 2. Connect to PostgreSQL database via Prisma
    await prisma.$connect();
    console.log('✅ PostgreSQL Database connected successfully via Prisma');

    // Start background worker for scheduled publishing
    SchedulerService.startWorker();

    app.listen(config.port, '0.0.0.0', () => {
      console.log(`====================================================`);
      console.log(`🚀 Social Media Management Backend running on port ${config.port}`);
      console.log(`👉 Health check: http://localhost:${config.port}/api/health`);
      console.log(`👉 Environment: ${config.nodeEnv}`);
      console.log(`====================================================`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Graceful Shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server and disconnecting Prisma');
  SchedulerService.stopWorker();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT signal received: closing HTTP server and disconnecting Prisma');
  SchedulerService.stopWorker();
  await prisma.$disconnect();
  process.exit(0);
});

start();

export default app;
