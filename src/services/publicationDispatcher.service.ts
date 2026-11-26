import axios from 'axios';
import { config } from '../config';
import { CryptoService } from './crypto.service';
import { MetaService } from './meta.service';
import { LinkedInService } from './linkedin.service';

export interface DispatchPublicationParams {
  content: {
    id: string;
    caption: string;
    mediaUrls?: string | null;
    format?: string | null;
    firstComment?: string | null;
  };
  account: {
    id: string;
    platform: string;
    platformAccountId: string;
    accessToken: string;
    metadata?: string | null;
    pageCategory?: string | null;
  };
  mediaUrlOverride?: string;
}

export function extractPrimaryMediaUrl(rawMediaUrls?: string | null): string | undefined {
  if (!rawMediaUrls) return undefined;
  let candidate: string | undefined;
  try {
    const parsed = JSON.parse(rawMediaUrls);
    if (Array.isArray(parsed)) candidate = parsed[0];
    else if (typeof parsed === 'string') candidate = parsed;
  } catch {
    if (typeof rawMediaUrls === 'string' && rawMediaUrls.startsWith('http')) {
      candidate = rawMediaUrls;
    }
  }
  if (!candidate || typeof candidate !== 'string') return undefined;
  if (candidate.startsWith('http://') && !candidate.includes('localhost')) {
    return candidate.replace('http://', 'https://');
  }
  return candidate;
}

export class PublicationDispatcherService {
  /**
   * Resolves target social accounts matching content.targetPlatforms when provided,
   * falling back to all connected accounts (or all brand accounts if none marked connected).
   */
  static selectTargetAccounts<T extends { id: string; platform?: string | null; isConnected?: boolean | null }>(
    brandAccounts: T[],
    rawTargetPlatforms?: string | null
  ): T[] {
    if (!brandAccounts || brandAccounts.length === 0) return [];
    const connected = brandAccounts.filter(a => a.isConnected !== false);
    const pool = connected.length > 0 ? connected : brandAccounts;

    if (!rawTargetPlatforms) return pool;
    try {
      const parsed = JSON.parse(rawTargetPlatforms);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const wanted = new Set(parsed.map((p: any) => String(p).toUpperCase().replace(/^X$/, 'TWITTER')));
        const matched = pool.filter(a => a.platform && wanted.has(a.platform.toUpperCase()));
        if (matched.length > 0) return matched;
      }
    } catch {
      // Ignore unparseable targetPlatforms JSON
    }
    return pool;
  }

  /**
   * Publishes a Content item to a single connected social account via the real platform API,
   * then triggers optional first-comment autopilot. Throws on token or API errors.
   */
  static async dispatchToAccount(params: DispatchPublicationParams): Promise<{ postId: string; postUrl: string }> {
    const { content, account, mediaUrlOverride } = params;
    const mediaUrl = mediaUrlOverride ?? extractPrimaryMediaUrl(content.mediaUrls);

    const rawAccessToken = CryptoService.isEncrypted(account.accessToken)
      ? CryptoService.decrypt(account.accessToken)
      : account.accessToken;

    if (!rawAccessToken || rawAccessToken === 'demo_sandbox_access_token') {
      throw new Error(`Account ${account.platform} (${account.platformAccountId}) lacks live API credentials`);
    }

    const platform = (account.platform || '').toUpperCase();
    let result: { success: true; postId: string; postUrl: string };

    if (platform === 'FACEBOOK') {
      result = await MetaService.publishToFacebookPage(
        account.platformAccountId,
        rawAccessToken,
        content.caption,
        mediaUrl
      );
    } else if (platform === 'INSTAGRAM') {
      if (!mediaUrl) {
        throw new Error('Instagram publishing requires an image or video URL');
      }
      result = await MetaService.publishToInstagram(
        account.platformAccountId,
        rawAccessToken,
        content.caption,
        mediaUrl,
        { mediaType: content.format || undefined }
      );
    } else if (platform === 'LINKEDIN') {
      let authorUrn = `urn:li:person:${account.platformAccountId}`;
      try {
        const meta = account.metadata ? JSON.parse(account.metadata) : {};
        if (meta.personUrn) authorUrn = meta.personUrn;
      } catch {
        // Keep default person URN
      }
      result = await LinkedInService.publishPost(
        authorUrn,
        rawAccessToken,
        content.caption,
        mediaUrl
      );
    } else {
      throw new Error(`Unsupported publishing platform: ${account.platform}`);
    }

    if (!result?.postId) {
      throw new Error(`${platform} API returned an empty platform post ID`);
    }

    // Optional First-Comment Autopilot (non-fatal)
    if (content.firstComment && content.firstComment.trim()) {
      try {
        if (platform === 'LINKEDIN') {
          const authorUrn = account.pageCategory === 'COMPANY_PAGE'
            ? `urn:li:organization:${account.platformAccountId}`
            : `urn:li:person:${account.platformAccountId}`;
          await axios.post(
            `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(result.postId)}/comments`,
            {
              actor: authorUrn,
              message: { text: content.firstComment.trim() }
            },
            {
              headers: {
                Authorization: `Bearer ${rawAccessToken}`,
                'Content-Type': 'application/json',
                'X-Restli-Protocol-Version': '2.0.0'
              },
              timeout: 15000
            }
          );
        } else if (platform === 'FACEBOOK' || platform === 'INSTAGRAM') {
          await axios.post(
            `${config.meta.graphBaseUrl}/${result.postId}/comments`,
            { message: content.firstComment.trim() },
            { params: { access_token: rawAccessToken }, timeout: 15000 }
          );
        }
      } catch (commentErr: any) {
        console.warn('[First-Comment Autopilot Notice]:', commentErr.response?.data?.error?.message || commentErr.message);
      }
    }

    return {
      postId: result.postId,
      postUrl: result.postUrl
    };
  }
}
