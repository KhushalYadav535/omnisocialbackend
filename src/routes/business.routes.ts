import { Router, Response } from 'express';
import { prisma } from '../services/db.service';
import { authenticateToken, requireTenant, AuthRequest } from '../middleware/auth.middleware';
import { AuditService } from '../services/audit.service';

const router = Router();

router.use(authenticateToken);
router.use(requireTenant);

// 1. Get Businesses for Current Tenant
router.get('/businesses', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const businesses = await prisma.business.findMany({
      where: { tenantId: req.user?.tenantId! },
      include: {
        _count: {
          select: { brands: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ businesses });
  } catch (err: any) {
    console.error('List businesses error:', err);
    res.status(500).json({ error: err.message || 'Failed to list businesses' });
  }
});

// 2. Create Business
router.post('/businesses', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name, legalName, industry, website } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Business name is required' });
      return;
    }

    const business = await prisma.business.create({
      data: {
        tenantId: req.user!.tenantId!,
        name,
        legalName: legalName || name,
        industry: industry || 'General',
        website: website || '',
        status: 'ACTIVE'
      }
    });

    await AuditService.record({
      tenantId: req.user?.tenantId,
      userId: req.user?.id,
      action: 'BUSINESS_CREATED',
      entityType: 'Business',
      entityId: business.id,
      details: { name }
    });

    res.status(201).json({ success: true, business });
  } catch (err: any) {
    console.error('Create business error:', err);
    res.status(500).json({ error: err.message || 'Failed to create business' });
  }
});

// 3. Get Brands for Current Tenant (optionally filter by businessId)
router.get('/brands', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { businessId } = req.query;

    const brands = await prisma.brand.findMany({
      where: {
        business: {
          tenantId: req.user?.tenantId!
        },
        ...(businessId && typeof businessId === 'string' ? { businessId } : {})
      },
      include: {
        business: {
          select: { id: true, name: true }
        },
        voiceProfile: true,
        socialAccounts: {
          select: {
            id: true,
            platform: true,
            accountName: true,
            username: true,
            profilePicUrl: true,
            isConnected: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const enrichedBrands = brands.map(brand => ({
      id: brand.id,
      businessId: brand.businessId,
      name: brand.name,
      slug: brand.slug,
      logoUrl: brand.logoUrl,
      description: brand.description,
      website: brand.website,
      status: brand.status,
      createdAt: brand.createdAt,
      updatedAt: brand.updatedAt,
      businessName: brand.business?.name,
      voiceProfile: brand.voiceProfile || null,
      accountsCount: brand.socialAccounts.length,
      socialAccounts: brand.socialAccounts
    }));

    res.json({ brands: enrichedBrands });
  } catch (err: any) {
    console.error('List brands error:', err);
    res.status(500).json({ error: err.message || 'Failed to list brands' });
  }
});

// 4. Create Brand under Business
router.post('/brands', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { businessId, name, description, website, tone, writingStyle, targetAudience, bannedKeywords } = req.body;

    if (!businessId || !name) {
      res.status(400).json({ error: 'Business ID and Brand Name are required' });
      return;
    }

    // Validate business ownership under this tenant
    const business = await prisma.business.findFirst({
      where: {
        id: businessId,
        tenantId: req.user?.tenantId!
      }
    });

    if (!business) {
      res.status(404).json({ error: 'Business not found under this tenant organization' });
      return;
    }

    const brandSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Math.floor(Math.random() * 1000);

    const result = await prisma.$transaction(async (tx) => {
      const brand = await tx.brand.create({
        data: {
          businessId,
          name,
          slug: brandSlug,
          logoUrl: 'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=120&h=120&fit=crop',
          description: description || '',
          website: website || '',
          status: 'ACTIVE'
        }
      });

      const voice = await tx.brandVoiceProfile.create({
        data: {
          brandId: brand.id,
          tone: tone || 'Professional, friendly, and helpful',
          writingStyle: writingStyle || 'Conversational and engaging',
          targetAudience: targetAudience || 'Modern consumers and professionals',
          keyTerminology: '',
          bannedKeywords: bannedKeywords || '',
          standardFaqs: '',
          responseGuidelines: 'Always respond politely and maintain brand integrity.',
          exampleReplies: '[]'
        }
      });

      return { brand, voice };
    });

    await AuditService.record({
      tenantId: req.user?.tenantId,
      userId: req.user?.id,
      action: 'BRAND_CREATED',
      entityType: 'Brand',
      entityId: result.brand.id,
      details: { name, businessName: business.name }
    });

    res.status(201).json({
      success: true,
      brand: {
        ...result.brand,
        businessName: business.name,
        voiceProfile: result.voice,
        accountsCount: 0,
        socialAccounts: []
      }
    });
  } catch (err: any) {
    console.error('Create brand error:', err);
    res.status(500).json({ error: err.message || 'Failed to create brand' });
  }
});

// 5. Update Brand Voice Profile & AI Guidelines
router.put('/brands/:id/voice', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const { tone, writingStyle, targetAudience, keyTerminology, bannedKeywords, standardFaqs, responseGuidelines, exampleReplies } = req.body;

    // Verify brand ownership through business relation to current tenant
    const brand = await prisma.brand.findFirst({
      where: {
        id,
        business: {
          tenantId: req.user?.tenantId!
        }
      }
    });

    if (!brand) {
      res.status(404).json({ error: 'Brand not found or not owned by your tenant' });
      return;
    }

    const exampleRepliesStr = typeof exampleReplies === 'string'
      ? exampleReplies
      : JSON.stringify(exampleReplies || []);

    const voice = await prisma.brandVoiceProfile.upsert({
      where: { brandId: id },
      update: {
        ...(tone !== undefined ? { tone } : {}),
        ...(writingStyle !== undefined ? { writingStyle } : {}),
        ...(targetAudience !== undefined ? { targetAudience } : {}),
        ...(keyTerminology !== undefined ? { keyTerminology } : {}),
        ...(bannedKeywords !== undefined ? { bannedKeywords } : {}),
        ...(standardFaqs !== undefined ? { standardFaqs } : {}),
        ...(responseGuidelines !== undefined ? { responseGuidelines } : {}),
        ...(exampleReplies !== undefined ? { exampleReplies: exampleRepliesStr } : {})
      },
      create: {
        brandId: id,
        tone: tone || 'Friendly and professional',
        writingStyle: writingStyle || '',
        targetAudience: targetAudience || '',
        keyTerminology: keyTerminology || '',
        bannedKeywords: bannedKeywords || '',
        standardFaqs: standardFaqs || '',
        responseGuidelines: responseGuidelines || '',
        exampleReplies: exampleRepliesStr
      }
    });

    await AuditService.record({
      tenantId: req.user?.tenantId,
      userId: req.user?.id,
      action: 'BRAND_VOICE_UPDATED',
      entityType: 'BrandVoiceProfile',
      entityId: voice.id,
      details: { brandName: brand.name, updatedTone: voice.tone }
    });

    res.json({ success: true, voiceProfile: voice });
  } catch (err: any) {
    console.error('Update brand voice error:', err);
    res.status(500).json({ error: err.message || 'Failed to update brand voice' });
  }
});

export default router;
