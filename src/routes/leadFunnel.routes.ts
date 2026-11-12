import { Router, Response } from 'express';
import { prisma } from '../services/db.service';
import { authenticateToken, requireTenant, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.use(requireTenant);

/**
 * 1. List Lead Funnels for a Brand
 */
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { brandId } = req.query;

    if (!brandId || typeof brandId !== 'string') {
      res.status(400).json({ error: 'brandId query parameter is required' });
      return;
    }

    const funnels = await prisma.leadFunnel.findMany({
      where: {
        brandId,
        brand: { business: { tenantId: req.user?.tenantId! } }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      funnels
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to list lead funnels' });
  }
});

/**
 * 2. Create New Comment-to-DM Lead Funnel
 */
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      brandId,
      name,
      triggerKeyword,
      matchType = 'CONTAINS',
      publicReply,
      dmMessage,
      assetUrl
    } = req.body;

    if (!brandId || !name || !triggerKeyword || !publicReply || !dmMessage) {
      res.status(400).json({ error: 'brandId, name, triggerKeyword, publicReply and dmMessage are required' });
      return;
    }

    const brand = await prisma.brand.findFirst({
      where: { id: brandId, business: { tenantId: req.user?.tenantId! } }
    });

    if (!brand) {
      res.status(404).json({ error: 'Brand not found or not owned by your organization' });
      return;
    }

    const funnel = await prisma.leadFunnel.create({
      data: {
        brandId: brand.id,
        name: name.trim(),
        triggerKeyword: triggerKeyword.trim().toUpperCase(),
        matchType,
        publicReply: publicReply.trim(),
        dmMessage: dmMessage.trim(),
        assetUrl: assetUrl ? assetUrl.trim() : null
      }
    });

    res.json({
      success: true,
      funnel
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create lead funnel' });
  }
});

/**
 * 3. Update or Toggle Active Status of Lead Funnel
 */
router.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    const { isActive, name, triggerKeyword, publicReply, dmMessage, assetUrl } = req.body;

    const existing = await prisma.leadFunnel.findFirst({
      where: { id, brand: { business: { tenantId: req.user?.tenantId! } } }
    });

    if (!existing) {
      res.status(404).json({ error: 'Lead funnel not found' });
      return;
    }

    const updated = await prisma.leadFunnel.update({
      where: { id },
      data: {
        ...(typeof isActive === 'boolean' ? { isActive } : {}),
        ...(name ? { name: name.trim() } : {}),
        ...(triggerKeyword ? { triggerKeyword: triggerKeyword.trim().toUpperCase() } : {}),
        ...(publicReply ? { publicReply: publicReply.trim() } : {}),
        ...(dmMessage ? { dmMessage: dmMessage.trim() } : {}),
        ...(assetUrl !== undefined ? { assetUrl: assetUrl ? assetUrl.trim() : null } : {})
      }
    });

    res.json({
      success: true,
      funnel: updated
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to update lead funnel' });
  }
});

/**
 * 4. Delete Lead Funnel
 */
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);

    const existing = await prisma.leadFunnel.findFirst({
      where: { id, brand: { business: { tenantId: req.user?.tenantId! } } }
    });

    if (!existing) {
      res.status(404).json({ error: 'Lead funnel not found' });
      return;
    }

    await prisma.leadFunnel.delete({
      where: { id }
    });

    res.json({
      success: true,
      message: 'Lead funnel deleted successfully'
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to delete lead funnel' });
  }
});

/**
 * 5. Test Trigger Simulator (Verify instant Public Reply + DM payload)
 */
router.post('/test-trigger', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { funnelId, commenterName = 'Alex Mercer', simulatedComment = 'Please send me the AI framework!' } = req.body;

    if (!funnelId) {
      res.status(400).json({ error: 'funnelId is required' });
      return;
    }

    const funnel = await prisma.leadFunnel.findFirst({
      where: { id: funnelId, brand: { business: { tenantId: req.user?.tenantId! } } }
    });

    if (!funnel) {
      res.status(404).json({ error: 'Lead funnel not found' });
      return;
    }

    // Check keyword match
    const commentUpper = simulatedComment.toUpperCase();
    const isMatch = funnel.matchType === 'EXACT'
      ? commentUpper === funnel.triggerKeyword
      : commentUpper.includes(funnel.triggerKeyword);

    if (!isMatch) {
      res.json({
        success: false,
        matched: false,
        message: `Simulated comment "${simulatedComment}" did not match keyword "${funnel.triggerKeyword}".`
      });
      return;
    }

    // Construct personalized responses
    const formattedPublicReply = funnel.publicReply
      .replace(/{name}/gi, commenterName)
      .replace(/{author}/gi, commenterName);

    let formattedDm = funnel.dmMessage
      .replace(/{name}/gi, commenterName)
      .replace(/{author}/gi, commenterName);

    if (funnel.assetUrl && !formattedDm.includes(funnel.assetUrl)) {
      formattedDm += `\n\n📥 Download Link: ${funnel.assetUrl}`;
    }

    // Increment trigger count
    await prisma.leadFunnel.update({
      where: { id: funnel.id },
      data: { triggersCount: { increment: 1 } }
    });

    res.json({
      success: true,
      matched: true,
      keywordDetected: funnel.triggerKeyword,
      publicReply: formattedPublicReply,
      directMessageDelivery: formattedDm,
      funnelName: funnel.name
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to simulate trigger' });
  }
});

export default router;
