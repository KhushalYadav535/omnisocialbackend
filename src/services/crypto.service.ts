import crypto from 'crypto';
import { config } from '../config';

export class CryptoService {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly IV_LENGTH = 12; // 96 bits for GCM
  private static readonly AUTH_TAG_LENGTH = 16; // 128 bits
  private static cachedKey: Buffer | null = null;

  /**
   * Validates cryptographic configuration at application startup.
   * Fails closed immediately if encryption key or secret is missing or invalid.
   */
  static validateStartupConfiguration(): void {
    const rawKey = config.meta.tokenEncryptionKey || process.env.META_TOKEN_ENCRYPTION_KEY;
    if (!rawKey || typeof rawKey !== 'string' || rawKey.trim() === '') {
      throw new Error('FATAL SECURITY ERROR: META_TOKEN_ENCRYPTION_KEY must be configured in environment');
    }

    let keyBuffer: Buffer;
    if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
      keyBuffer = Buffer.from(rawKey, 'hex');
    } else if (rawKey.length === 32) {
      keyBuffer = Buffer.from(rawKey, 'utf8');
    } else {
      throw new Error(`FATAL SECURITY ERROR: Encryption key must be exactly 32 bytes (256 bits). Expected 64 hex characters or 32 characters, got ${rawKey.length} characters.`);
    }

    if (keyBuffer.length !== 32) {
      throw new Error(`FATAL SECURITY ERROR: Encryption key must be exactly 32 bytes (256 bits). Got ${keyBuffer.length} bytes.`);
    }

    const appSecret = config.meta.appSecret || process.env.META_APP_SECRET;
    if (!appSecret || typeof appSecret !== 'string' || appSecret.trim() === '') {
      throw new Error('FATAL SECURITY ERROR: META_APP_SECRET must be configured for OAuth signing and webhook verification');
    }

    this.cachedKey = keyBuffer;
  }

  /**
   * Retrieves or derives the 32-byte (256-bit) encryption key
   */
  private static getEncryptionKey(): Buffer {
    if (this.cachedKey) return this.cachedKey;

    const rawKey = config.meta.tokenEncryptionKey || process.env.META_TOKEN_ENCRYPTION_KEY;
    if (!rawKey) {
      throw new Error('META_TOKEN_ENCRYPTION_KEY is not configured in environment');
    }

    if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
      this.cachedKey = Buffer.from(rawKey, 'hex');
    } else if (rawKey.length === 32) {
      this.cachedKey = Buffer.from(rawKey, 'utf8');
    } else {
      throw new Error(`FATAL SECURITY ERROR: Encryption key must be exactly 32 bytes (256 bits). Expected 64 hex characters or 32 characters, got ${rawKey.length} characters.`);
    }

    if (this.cachedKey.length !== 32) {
      throw new Error(`Invalid encryption key length: expected 32 bytes, got ${this.cachedKey.length}`);
    }

    return this.cachedKey;
  }

  /**
   * Encrypts plaintext access token at rest using AES-256-GCM.
   * Produces formatted string: `${ivHex}:${authTagHex}:${ciphertextHex}`
   * Cryptographically secure 12-byte random IV is generated for EVERY call.
   */
  static encrypt(plaintext: string): string {
    if (!plaintext) {
      throw new Error('Cannot encrypt empty plaintext');
    }

    const key = this.getEncryptionKey();
    const iv = crypto.randomBytes(this.IV_LENGTH);

    const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv, {
      authTagLength: this.AUTH_TAG_LENGTH
    });

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final()
    ]);

    const authTag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  /**
   * Decrypts AES-256-GCM encrypted token string.
   * Validates authentication tag to ensure data integrity and authenticity.
   */
  static decrypt(encryptedString: string, customKey?: Buffer): string {
    if (!encryptedString) {
      throw new Error('Cannot decrypt empty string');
    }

    const parts = encryptedString.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted token format. Expected "iv:authTag:ciphertext"');
    }

    const [ivHex, authTagHex, ciphertextHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const ciphertext = Buffer.from(ciphertextHex, 'hex');

    if (iv.length !== this.IV_LENGTH) {
      throw new Error(`Invalid IV length: expected ${this.IV_LENGTH} bytes, got ${iv.length}`);
    }

    if (authTag.length !== this.AUTH_TAG_LENGTH) {
      throw new Error(`Invalid AuthTag length: expected ${this.AUTH_TAG_LENGTH} bytes, got ${authTag.length}`);
    }

    const key = customKey || this.getEncryptionKey();
    const decipher = crypto.createDecipheriv(this.ALGORITHM, key, iv, {
      authTagLength: this.AUTH_TAG_LENGTH
    });

    decipher.setAuthTag(authTag);

    try {
      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ]);
      return decrypted.toString('utf8');
    } catch {
      throw new Error('Decryption failed: Token is corrupted, invalid key, or authentication tag mismatch');
    }
  }

  /**
   * Checks if string matches the AES-256-GCM encrypted format
   */
  static isEncrypted(value: string): boolean {
    if (!value || typeof value !== 'string') return false;
    const parts = value.split(':');
    if (parts.length !== 3) return false;
    const [iv, authTag, cipher] = parts;
    return (
      /^[0-9a-fA-F]{24}$/.test(iv) && // 12 bytes = 24 hex
      /^[0-9a-fA-F]{32}$/.test(authTag) && // 16 bytes = 32 hex
      /^[0-9a-fA-F]+$/.test(cipher)
    );
  }

  /**
   * Safely masks an access token for audit logs and error messages
   * e.g. "EAAB...wxyz"
   */
  static maskToken(token: string): string {
    if (!token) return '***';
    if (token.length <= 10) return '***';
    return `${token.substring(0, 6)}...${token.substring(token.length - 4)}`;
  }

  /**
   * Creates a cryptographically signed CSRF state token for Meta OAuth 2.0 flow
   * binds user, tenant, brand, timestamp, and server-managed nonce.
   */
  static signOAuthState(payload: {
    userId: string;
    tenantId: string;
    brandId: string;
    nonce?: string;
    [key: string]: any;
  }, customNonce?: string): { state: string; nonce: string } {
    const nonce = customNonce || payload.nonce || crypto.randomBytes(16).toString('hex');
    const fullPayload = {
      ...payload,
      nonce,
      ts: Date.now()
    };

    const payloadJson = JSON.stringify(fullPayload);
    const payloadB64 = Buffer.from(payloadJson, 'utf8').toString('base64url');
    const secret = config.meta.appSecret || 'default_oauth_signing_secret';
    const signature = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');

    return {
      state: `${payloadB64}.${signature}`,
      nonce
    };
  }

  /**
   * Validates and unpacks a cryptographically signed CSRF state token.
   * Enforces 10-minute expiry and constant-time signature verification.
   */
  static verifyOAuthState<T = any>(stateStr: string, maxAgeMs: number = 10 * 60 * 1000): T {
    if (!stateStr || typeof stateStr !== 'string') {
      throw new Error('Invalid OAuth state parameter: State is missing');
    }

    const parts = stateStr.split('.');
    if (parts.length !== 2) {
      throw new Error('Invalid OAuth state parameter: Bad signature format');
    }

    const [payloadB64, signature] = parts;
    const secret = config.meta.appSecret || 'default_oauth_signing_secret';
    const expectedSignature = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');

    // Constant-time signature comparison to eliminate timing attacks
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      throw new Error('Invalid OAuth state parameter: Cryptographic signature mismatch or state tampered');
    }

    let payload: any;
    try {
      const jsonStr = Buffer.from(payloadB64, 'base64url').toString('utf8');
      payload = JSON.parse(jsonStr);
    } catch {
      throw new Error('Invalid OAuth state parameter: Malformed payload encoding');
    }

    if (!payload.ts || typeof payload.ts !== 'number') {
      throw new Error('Invalid OAuth state parameter: Missing timestamp');
    }

    if (!payload.nonce || typeof payload.nonce !== 'string') {
      throw new Error('Invalid OAuth state parameter: Missing nonce');
    }

    const age = Date.now() - payload.ts;
    if (age > maxAgeMs) {
      throw new Error(`OAuth state parameter expired (${Math.round(age / 1000)}s old, max ${Math.round(maxAgeMs / 1000)}s)`);
    }

    return payload as T;
  }

  /**
   * Verifies Meta Webhook HMAC-SHA256 signature using constant-time comparison
   * Strictly validates header format and signature length.
   */
  static verifyMetaWebhookSignature(
    rawBody: Buffer | string | undefined,
    signatureHeader: string | undefined,
    appSecret?: string
  ): boolean {
    if (!signatureHeader || !rawBody) return false;

    const secret = appSecret || config.meta.appSecret;
    if (!secret) return false;

    // Header format: 'sha256=<hex-digest>'
    const prefix = 'sha256=';
    if (!signatureHeader.startsWith(prefix)) return false;

    const receivedHex = signatureHeader.substring(prefix.length).trim();
    // Validate exact 64-character SHA-256 hex string
    if (!/^[0-9a-fA-F]{64}$/.test(receivedHex)) return false;

    const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
    const computedHex = crypto.createHmac('sha256', secret).update(bodyBuffer).digest('hex');

    const receivedBuffer = Buffer.from(receivedHex, 'hex');
    const computedBuffer = Buffer.from(computedHex, 'hex');

    if (receivedBuffer.length !== computedBuffer.length) return false;

    return crypto.timingSafeEqual(receivedBuffer, computedBuffer);
  }

  /**
   * Safe Encryption Key Rotation Utility:
   * Re-encrypts an existing encrypted token using a new key.
   */
  static rotateToken(encryptedToken: string, oldKeyBuffer: Buffer, newKeyBuffer: Buffer): string {
    const plaintext = this.decrypt(encryptedToken, oldKeyBuffer);
    const iv = crypto.randomBytes(this.IV_LENGTH);
    const cipher = crypto.createCipheriv(this.ALGORITHM, newKeyBuffer, iv, {
      authTagLength: this.AUTH_TAG_LENGTH
    });
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }
}
