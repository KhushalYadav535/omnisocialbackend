import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { CryptoService } from './crypto.service';

export interface LinkedInProfile {
  sub: string;
  name: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
  email?: string;
  personUrn: string;
}

export class LinkedInApiError extends Error {
  public status?: number;
  public serviceErrorCode?: number;
  public details?: any;
  public isTokenExpired: boolean;

  constructor(message: string, status?: number, serviceErrorCode?: number, details?: any) {
    super(message);
    this.name = 'LinkedInApiError';
    this.status = status;
    this.serviceErrorCode = serviceErrorCode;
    this.details = details;
    this.isTokenExpired = status === 401;
  }
}

export class LinkedInService {
  private static apiVersion = config.linkedin.apiVersion || '202610';

  /**
   * Generates LinkedIn OAuth 2.0 Authorization URL with cryptographically signed CSRF state.
   */
  static getAuthorizationUrl(
    userId: string,
    tenantId: string,
    brandId: string,
    customClientId?: string | null,
    nonce?: string,
    customRedirectUri?: string | null
  ): { oauthUrl: string; state: string; nonce: string } {
    const clientId = customClientId || config.linkedin.clientId;
    if (!clientId) {
      throw new Error('LinkedIn Client ID is missing. Please configure Linkedin_Client_Id in .env');
    }

    const redirectUri = encodeURIComponent(customRedirectUri || config.linkedin.redirectUri);

    const { state, nonce: generatedNonce } = CryptoService.signOAuthState({
      userId,
      tenantId,
      brandId,
      platform: 'LINKEDIN'
    }, nonce);

    // Standard OpenID Connect + Share scopes
    // openid, profile, email -> Granted by "Sign In with LinkedIn using OpenID Connect" product
    // w_member_social -> Granted by "Share on LinkedIn" product
    const scope = encodeURIComponent('openid profile email w_member_social');
    const oauthUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${redirectUri}&scope=${scope}&state=${state}`;

    return {
      oauthUrl,
      state,
      nonce: generatedNonce
    };
  }

  /**
   * Exchanges authorization code for a LinkedIn Access Token.
   */
  static async exchangeCodeForToken(
    code: string,
    customClientId?: string | null,
    customClientSecret?: string | null,
    customRedirectUri?: string | null
  ): Promise<{ accessToken: string; expiresIn: number; idToken?: string; scope?: string }> {
    const clientId = customClientId || config.linkedin.clientId;
    const clientSecret = customClientSecret || config.linkedin.clientSecret;
    const redirectUri = customRedirectUri || config.linkedin.redirectUri;

    if (!clientId || !clientSecret) {
      throw new Error('LinkedIn Client ID or Client Secret is missing in backend configuration');
    }

    try {
      const params = new URLSearchParams();
      params.append('grant_type', 'authorization_code');
      params.append('code', code);
      params.append('redirect_uri', redirectUri);
      params.append('client_id', clientId);
      params.append('client_secret', clientSecret);

      const response = await axios.post('https://www.linkedin.com/oauth/v2/accessToken', params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 15000
      });

      const accessToken = response.data?.access_token;
      const expiresIn = response.data?.expires_in || 60 * 86400; // typically 60 days
      const idToken = response.data?.id_token;
      const scope = response.data?.scope;

      if (!accessToken) {
        throw new LinkedInApiError('LinkedIn OAuth token response did not contain an access_token');
      }

      return {
        accessToken,
        expiresIn,
        idToken,
        scope
      };
    } catch (err: any) {
      if (err instanceof LinkedInApiError) throw err;
      const data = err.response?.data;
      const message = data?.error_description || data?.error || data?.message || err.message;
      throw new LinkedInApiError(`LinkedIn Token Exchange failed: ${message}`, err.response?.status, undefined, data);
    }
  }

  /**
   * Fetches authenticated member profile information using LinkedIn OpenID Connect userinfo endpoint.
   */
  static async fetchUserProfile(accessToken: string): Promise<LinkedInProfile> {
    try {
      const response = await axios.get('https://api.linkedin.com/v2/userinfo', {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        timeout: 15000
      });

      const data = response.data;
      const sub = data.sub;
      if (!sub) {
        throw new LinkedInApiError('Failed to extract member sub identifier from LinkedIn /v2/userinfo');
      }

      return {
        sub,
        name: data.name || `${data.given_name || ''} ${data.family_name || ''}`.trim() || 'LinkedIn Member',
        givenName: data.given_name,
        familyName: data.family_name,
        picture: data.picture,
        email: data.email,
        personUrn: `urn:li:person:${sub}`
      };
    } catch (err: any) {
      if (err instanceof LinkedInApiError) throw err;
      const data = err.response?.data;
      const message = data?.message || data?.error_description || err.message;
      throw new LinkedInApiError(`LinkedIn Profile fetch failed: ${message}`, err.response?.status, undefined, data);
    }
  }

  /**
   * Resolves binary image buffer from a URL, local path, or data URI.
   */
  private static async resolveImageBuffer(mediaUrl: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    try {
      if (mediaUrl.startsWith('data:image/')) {
        const matches = mediaUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (matches && matches.length === 3) {
          return {
            mimeType: matches[1],
            buffer: Buffer.from(matches[2], 'base64')
          };
        }
      }

      if (mediaUrl.includes('/uploads/')) {
        const parts = mediaUrl.split('/uploads/');
        const filename = parts[parts.length - 1].split('?')[0];
        const localPath = path.join(process.cwd(), 'uploads', filename);
        if (fs.existsSync(localPath)) {
          const ext = path.extname(filename).toLowerCase();
          const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
          return {
            mimeType,
            buffer: fs.readFileSync(localPath)
          };
        }
      }

      if (fs.existsSync(mediaUrl)) {
        const ext = path.extname(mediaUrl).toLowerCase();
        const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
        return {
          mimeType,
          buffer: fs.readFileSync(mediaUrl)
        };
      }

      if (mediaUrl.startsWith('http://') || mediaUrl.startsWith('https://')) {
        const remoteRes = await axios.get(mediaUrl, {
          responseType: 'arraybuffer',
          timeout: 25000
        });
        const rawHeader = remoteRes.headers['content-type'];
        const contentType = typeof rawHeader === 'string' ? rawHeader : 'image/jpeg';
        return {
          mimeType: contentType.split(';')[0],
          buffer: Buffer.from(remoteRes.data)
        };
      }
    } catch (err: any) {
      console.warn('⚠️ [LINKEDIN] Could not resolve image buffer from mediaUrl:', mediaUrl, err.message);
    }
    return null;
  }

  /**
   * Uploads an image asset to LinkedIn using the 2-step REST Images API.
   * Returns image URN e.g. "urn:li:image:C4E..."
   */
  static async uploadImage(ownerUrn: string, accessToken: string, mediaUrl: string): Promise<string> {
    const resolved = await this.resolveImageBuffer(mediaUrl);
    if (!resolved) {
      throw new LinkedInApiError(`Unable to fetch or read image for upload from ${mediaUrl}`);
    }

    try {
      // Step 1: Initialize image upload
      const initRes = await axios.post(
        'https://api.linkedin.com/rest/images?action=initializeUpload',
        {
          initializeUploadRequest: {
            owner: ownerUrn
          }
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Linkedin-Version': this.apiVersion,
            'X-Restli-Protocol-Version': '2.0.0',
            'Content-Type': 'application/json'
          },
          timeout: 20000
        }
      );

      const uploadUrl = initRes.data?.value?.uploadUrl;
      const imageUrn = initRes.data?.value?.image;

      if (!uploadUrl || !imageUrn) {
        throw new LinkedInApiError('LinkedIn Images API did not return uploadUrl or image URN');
      }

      // Step 2: Upload binary image to the uploadUrl
      await axios.put(uploadUrl, resolved.buffer, {
        headers: {
          'Content-Type': resolved.mimeType
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 45000
      });

      return imageUrn;
    } catch (err: any) {
      if (err instanceof LinkedInApiError) throw err;
      const data = err.response?.data;
      const message = data?.message || err.message;
      throw new LinkedInApiError(`LinkedIn Image upload failed: ${message}`, err.response?.status, undefined, data);
    }
  }

  /**
   * Publishes a post (text or image) to LinkedIn via the modern versioned Posts API (/rest/posts).
   */
  static async publishPost(
    authorUrn: string,
    accessToken: string,
    commentary: string,
    mediaUrl?: string
  ): Promise<{ success: true; postId: string; postUrl: string }> {
    // If authorUrn doesn't start with 'urn:li:', format as person URN
    const formattedAuthor = authorUrn.startsWith('urn:li:')
      ? authorUrn
      : `urn:li:person:${authorUrn}`;

    let imageUrn: string | null = null;
    if (mediaUrl) {
      try {
        imageUrn = await this.uploadImage(formattedAuthor, accessToken, mediaUrl);
      } catch (uploadErr: any) {
        console.warn('⚠️ [LINKEDIN] Image upload failed, falling back to commentary link/text:', uploadErr.message);
      }
    }

    try {
      // Build modern REST Posts API payload
      const postPayload: any = {
        author: formattedAuthor,
        commentary: commentary || '',
        visibility: 'PUBLIC',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: []
        },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false
      };

      if (imageUrn) {
        postPayload.content = {
          media: {
            id: imageUrn,
            altText: 'OmniSocial Published Content'
          }
        };
      }

      const response = await axios.post('https://api.linkedin.com/rest/posts', postPayload, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Linkedin-Version': this.apiVersion,
          'X-Restli-Protocol-Version': '2.0.0',
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });

      // LinkedIn Posts API returns 201 Created and the post URN in header 'x-restli-id'
      const postUrn = response.headers['x-restli-id'] || response.data?.id || `urn:li:share:${Date.now()}`;
      const postUrl = `https://www.linkedin.com/feed/update/${encodeURIComponent(postUrn)}`;

      return {
        success: true,
        postId: postUrn,
        postUrl
      };
    } catch (err: any) {
      // Attempt legacy UGC post fallback if REST posts is rejected due to version mismatch
      if (err.response?.status === 400 || err.response?.status === 403 || err.response?.status === 404) {
        try {
          return await this.publishUgcPostFallback(formattedAuthor, accessToken, commentary, mediaUrl);
        } catch (fallbackErr: any) {
          // If fallback fails as well, throw the original or fallback error
          console.error('LinkedIn REST Post and UGC Fallback both failed:', fallbackErr.message);
        }
      }

      const data = err.response?.data;
      const message = data?.message || data?.error_description || err.message;
      throw new LinkedInApiError(`LinkedIn Post creation failed: ${message}`, err.response?.status, data?.serviceErrorCode, data);
    }
  }

  /**
   * Fallback using LinkedIn /v2/ugcPosts for compatibility with developer accounts.
   */
  private static async publishUgcPostFallback(
    authorUrn: string,
    accessToken: string,
    text: string,
    mediaUrl?: string
  ): Promise<{ success: true; postId: string; postUrl: string }> {
    const payload: any = {
      author: authorUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text: text || ''
          },
          shareMediaCategory: 'NONE'
        }
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'
      }
    };

    const res = await axios.post('https://api.linkedin.com/v2/ugcPosts', payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    const postId = res.data?.id || `urn:li:ugcPost:${Date.now()}`;
    const postUrl = `https://www.linkedin.com/feed/update/${encodeURIComponent(postId)}`;

    return {
      success: true,
      postId,
      postUrl
    };
  }

  /**
   * Posts a comment/reply to a LinkedIn post or existing comment.
   */
  static async replyToComment(
    postOrCommentUrn: string,
    authorUrn: string,
    accessToken: string,
    commentText: string
  ): Promise<{ success: true; commentId: string }> {
    try {
      const formattedAuthor = authorUrn.startsWith('urn:li:') ? authorUrn : `urn:li:person:${authorUrn}`;
      const encodedUrn = encodeURIComponent(postOrCommentUrn);

      const response = await axios.post(
        `https://api.linkedin.com/rest/socialActions/${encodedUrn}/comments`,
        {
          actor: formattedAuthor,
          message: {
            text: commentText
          }
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Linkedin-Version': this.apiVersion,
            'X-Restli-Protocol-Version': '2.0.0',
            'Content-Type': 'application/json'
          },
          timeout: 20000
        }
      );

      const commentId = response.headers['x-restli-id'] || response.data?.id || `comment_${Date.now()}`;
      return {
        success: true,
        commentId
      };
    } catch (err: any) {
      const data = err.response?.data;
      const message = data?.message || err.message;
      throw new LinkedInApiError(`LinkedIn Comment Reply failed: ${message}`, err.response?.status, undefined, data);
    }
  }

  /**
   * Fetches comments for a LinkedIn post.
   */
  static async fetchComments(postUrn: string, accessToken: string): Promise<any[]> {
    try {
      const encodedUrn = encodeURIComponent(postUrn);
      const response = await axios.get(`https://api.linkedin.com/rest/socialActions/${encodedUrn}/comments`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Linkedin-Version': this.apiVersion,
          'X-Restli-Protocol-Version': '2.0.0'
        },
        timeout: 20000
      });

      return response.data?.elements || [];
    } catch (err: any) {
      console.warn('⚠️ [LINKEDIN] Could not fetch post comments:', err.message);
      return [];
    }
  }
}
