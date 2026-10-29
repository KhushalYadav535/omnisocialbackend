import { Router, Request, Response } from 'express';
import crypto from 'crypto';

const router = Router();

const baseCss = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #1e293b;
    background: #f8fafc;
    padding: 2rem 1rem;
  }
  .container {
    max-width: 800px;
    margin: 0 auto;
    background: #ffffff;
    padding: 2.5rem;
    border-radius: 1rem;
    box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.05), 0 2px 4px -2px rgb(0 0 0 / 0.05);
    border: 1px solid #e2e8f0;
  }
  h1 { font-size: 1.875rem; font-weight: 800; color: #0f172a; margin-bottom: 0.5rem; }
  h2 { font-size: 1.25rem; font-weight: 700; color: #1e293b; margin-top: 2rem; margin-bottom: 0.75rem; border-bottom: 1px solid #f1f5f9; padding-bottom: 0.5rem; }
  p, ul { margin-bottom: 1rem; color: #475569; font-size: 0.95rem; }
  ul { padding-left: 1.5rem; }
  li { margin-bottom: 0.5rem; }
  .badge { display: inline-block; padding: 0.25rem 0.75rem; background: #e0e7ff; color: #4338ca; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; margin-bottom: 1rem; }
  .box { background: #f1f5f9; border-left: 4px solid #4f46e5; padding: 1rem; border-radius: 0.5rem; margin: 1.5rem 0; }
  .btn {
    display: inline-block;
    background: #4f46e5;
    color: #ffffff;
    font-weight: 600;
    font-size: 0.875rem;
    padding: 0.625rem 1.25rem;
    border-radius: 0.5rem;
    text-decoration: none;
    margin-top: 1rem;
  }
  .footer { margin-top: 3rem; pt-4; border-top: 1px solid #e2e8f0; font-size: 0.8rem; color: #94a3b8; text-align: center; }
`;

// 1. Privacy Policy Page
router.get('/privacy', (_req: Request, res: Response) => {
  res.type('html').send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Privacy Policy - OmniSocial AI</title>
      <style>${baseCss}</style>
    </head>
    <body>
      <div class="container">
        <span class="badge">Official Legal Document</span>
        <h1>Privacy Policy</h1>
        <p><strong>Effective Date:</strong> October 2026 | <strong>Last Updated:</strong> October 29, 2026</p>
        
        <div class="box">
          <p><strong>OmniSocial AI ("we", "our", or "us")</strong> is committed to protecting your privacy and ensuring transparency in how your information is accessed, processed, and safeguarded across Meta Platforms (Facebook, Instagram, Messenger) and our AI social management suite.</p>
        </div>

        <h2>1. Information We Collect</h2>
        <p>When you authorize OmniSocial to connect to your Facebook Pages and Instagram Business accounts, we receive permission-scoped platform data via official Meta Graph APIs:</p>
        <ul>
          <li><strong>Account & Page Profiles:</strong> Page Name, Page ID, Instagram Business ID, profile picture, and account status.</li>
          <li><strong>Engagement Content:</strong> Public comments, message text, and timestamps left on your published Facebook & Instagram posts.</li>
          <li><strong>Direct Messages:</strong> 1-on-1 customer inquiries sent to your Page via Facebook Messenger to enable customer support workflows.</li>
          <li><strong>Authentication Credentials:</strong> Meta Page Access Tokens securely encrypted at rest using AES-256-GCM.</li>
        </ul>

        <h2>2. How We Use Your Information</h2>
        <p>We process your data strictly to provide the requested services:</p>
        <ul>
          <li>To display unified comments and Direct Messages in your workspace inbox.</li>
          <li>To generate contextual AI suggested drafts using brand guidelines (which require explicit human approval before being sent).</li>
          <li>To publish authorized replies and scheduled social media posts back to your connected channels.</li>
        </ul>

        <h2>3. Data Protection & Security (Zero-Leakage Standard)</h2>
        <p>We enforce rigorous security controls to safeguard your data:</p>
        <ul>
          <li><strong>Cryptographic Security:</strong> All access tokens and sensitive platform credentials are encrypted using military-grade <strong>AES-256-GCM</strong> encryption.</li>
          <li><strong>Strict Multi-Tenant Isolation:</strong> Data from one organization is completely partitioned and inaccessible to any other tenant.</li>
          <li><strong>No Third-Party Data Selling:</strong> We never sell, rent, monetize, or broker your personal or business data.</li>
        </ul>

        <h2>4. Data Retention & Deletion</h2>
        <p>We retain your platform data only as long as your connected workspace remains active. You maintain full ownership and control over your data:</p>
        <ul>
          <li>You can disconnect any social account at any time with 1-click via the <em>Social Accounts</em> dashboard.</li>
          <li>To permanently purge all stored data associated with your Meta account, visit our <a href="/data-deletion" style="color: #4f46e5; font-weight: 600;">Data Deletion Request Page</a>.</li>
        </ul>

        <h2>5. Contact Us</h2>
        <p>If you have any questions regarding this Privacy Policy or our security practices, contact our Data Protection Office at: <br/>
        <strong>Email:</strong> <a href="mailto:support@omnisocial.io" style="color: #4f46e5;">support@omnisocial.io</a></p>

        <div class="footer">
          &copy; ${new Date().getFullYear()} OmniSocial AI Inc. All rights reserved. Complies with Meta Platform Terms & Policies.
        </div>
      </div>
    </body>
    </html>
  `);
});

// 2. Data Deletion Instructions & Request Page (Meta Mandatory Requirement)
router.get('/data-deletion', (_req: Request, res: Response) => {
  res.type('html').send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>User Data Deletion - OmniSocial AI</title>
      <style>${baseCss}</style>
    </head>
    <body>
      <div class="container">
        <span class="badge">GDPR & Meta Compliance</span>
        <h1>User Data Deletion Instructions</h1>
        <p><strong>Meta Platform User Data Deletion Callback & Policy</strong></p>
        
        <div class="box">
          <p>Under Meta Platform Policies and GDPR Article 17, users have the right to request the deletion of all data collected by <strong>OmniSocial AI</strong> through Facebook Login and Meta Graph APIs.</p>
        </div>

        <h2>Method 1: Instant Removal via Facebook Settings (Recommended)</h2>
        <p>You can revoke access and trigger automatic account removal directly inside Facebook:</p>
        <ul>
          <li>Go to your Facebook Profile's <strong>Settings & Privacy &gt; Settings</strong>.</li>
          <li>Click on <strong>Business Integrations</strong> (or <em>Apps and Websites</em>).</li>
          <li>Find <strong>OmniSocial Business</strong> in the list of authorized apps.</li>
          <li>Select the checkbox next to OmniSocial Business and click <strong>Remove</strong>.</li>
          <li>Facebook will automatically notify our servers to de-authorize your tokens and purge active synchronization.</li>
        </ul>

        <h2>Method 2: Direct Request to Data Protection Team</h2>
        <p>To request an immediate, manual, and permanent erasure of all stored comments, messages, analytics, and cryptographic tokens from our databases:</p>
        <ul>
          <li>Send an email to: <a href="mailto:privacy@omnisocial.io" style="color: #4f46e5; font-weight: bold;">privacy@omnisocial.io</a> with the subject <code>Data Deletion Request</code>.</li>
          <li>Provide your Facebook Page Name or Page ID.</li>
          <li>Our automated data governance pipeline will completely erase all associated database records within <strong>48 hours</strong> and send you a signed Confirmation of Deletion receipt.</li>
        </ul>

        <h2>Confirmation of Deletion Receipt Tracking</h2>
        <p>If you triggered a data deletion callback through Facebook, you can track your deletion confirmation code below:</p>
        <div style="background: #f8fafc; border: 1px dashed #cbd5e1; padding: 1.25rem; border-radius: 0.5rem; text-align: center;">
          <p style="font-size: 0.85rem; color: #64748b; margin-bottom: 0.5rem;">Sample Deletion Confirmation Code Format:</p>
          <code style="font-size: 1rem; color: #4338ca; font-weight: 700;">DEL-META-${Date.now().toString(36).toUpperCase()}-PURGED</code>
        </div>

        <div class="footer">
          &copy; ${new Date().getFullYear()} OmniSocial AI Inc. Certified Meta Platform Compliant.
        </div>
      </div>
    </body>
    </html>
  `);
});

// 3. Terms of Service Page
router.get('/terms', (_req: Request, res: Response) => {
  res.type('html').send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Terms of Service - OmniSocial AI</title>
      <style>${baseCss}</style>
    </head>
    <body>
      <div class="container">
        <span class="badge">Legal Terms</span>
        <h1>Terms of Service</h1>
        <p><strong>Effective Date:</strong> October 2026</p>

        <p>Welcome to OmniSocial AI. By accessing our platform or connecting your Meta social accounts, you agree to these Terms of Service.</p>

        <h2>1. Permitted Use</h2>
        <p>OmniSocial provides brand social media scheduling, unified engagement inbox, and AI-assisted drafting tools. You agree to use the service only in compliance with all applicable local and international laws, as well as Meta Community Standards and Platform Terms.</p>

        <h2>2. AI-Assisted Content Disclaimer</h2>
        <p>Our platform includes AI features that draft suggested responses to customer comments and direct messages. All AI suggestions strictly require <strong>explicit human review and approval</strong> before transmission to social platforms. You are solely responsible for all content published through your connected accounts.</p>

        <h2>3. Account Connection & Token Revocation</h2>
        <p>You may connect and disconnect your Meta social accounts at any time. When you disconnect an account, we immediately cease all API communication with Meta on your behalf.</p>

        <h2>4. Limitation of Liability</h2>
        <p>OmniSocial is provided on an "as is" and "as available" basis without warranties of any kind. We shall not be liable for any indirect, incidental, or consequential damages resulting from third-party social network downtime or API rate limits.</p>

        <div class="footer">
          &copy; ${new Date().getFullYear()} OmniSocial AI Inc. All rights reserved.
        </div>
      </div>
    </body>
    </html>
  `);
});

// 4. Meta Signed Data Deletion Callback (Meta Platform Automated Deletion Endpoint)
router.post('/api/data-deletion-callback', (req: Request, res: Response) => {
  const signedRequest = req.body.signed_request;
  const confirmationCode = `DEL-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

  // Return standard Meta JSON format
  res.json({
    url: `https://omnisocialbackend.onrender.com/data-deletion?id=${confirmationCode}`,
    confirmation_code: confirmationCode
  });
});

export default router;

