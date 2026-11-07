/**
 * Server-only Nodemailer wrapper for BALE.
 *
 * NEVER import this module from client components. SMTP credentials are read
 * exclusively from private (non-NEXT_PUBLIC_) environment variables and are
 * never returned to callers or logged.
 */

import nodemailer from 'nodemailer';

export interface SmtpConfigStatus {
  configured: boolean;
  missing: string[];
}

const REQUIRED_SMTP_VARS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM_ADDRESS'] as const;

/** Reports whether every required SMTP variable is present (no values leaked). */
export function getSmtpConfigStatus(): SmtpConfigStatus {
  const missing = REQUIRED_SMTP_VARS.filter((name) => !(process.env[name] || '').trim());
  return { configured: missing.length === 0, missing: [...missing] };
}

export function isSmtpConfigured(): boolean {
  return getSmtpConfigStatus().configured;
}

export function getFirmEmailIdentity() {
  return {
    fromName: (process.env.EMAIL_FROM_NAME || 'Asinta Architects').trim(),
    fromAddress: (process.env.EMAIL_FROM_ADDRESS || '').trim(),
    replyTo: (process.env.EMAIL_REPLY_TO || '').trim() || undefined,
    firmContactNumber: (process.env.FIRM_CONTACT_NUMBER || '').trim(),
  };
}

export interface SendEmailParams {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface SendEmailResult {
  /** true when the SMTP server ACCEPTED the message (not proof of delivery). */
  accepted: boolean;
  /** The provider may have accepted the message despite a lost response. */
  uncertain?: boolean;
  providerMessageId?: string;
  /** Safe, human-readable error. Never contains credentials. */
  error?: string;
}

/** Maps SMTP/Nodemailer failures to safe messages without leaking secrets. */
function toSafeSmtpError(error: unknown): string {
  const err = error as { code?: string; responseCode?: number; message?: string };
  if (err?.code === 'EAUTH' || err?.responseCode === 535) {
    return 'SMTP authentication failed. Verify SMTP_USER and SMTP_PASS on the server.';
  }
  if (err?.code === 'ETIMEDOUT' || err?.code === 'ESOCKET' || err?.code === 'ECONNECTION') {
    return 'Could not reach the SMTP server (connection failed or timed out). Verify SMTP_HOST, SMTP_PORT, and SMTP_SECURE.';
  }
  if (err?.code === 'EENVELOPE' || err?.responseCode === 550 || err?.responseCode === 553) {
    return 'The SMTP server rejected the sender or recipient address.';
  }
  if (err?.responseCode === 554) {
    return 'The SMTP server rejected the message (relay denied or content refused).';
  }
  const raw = typeof err?.message === 'string' ? err.message : 'Unknown SMTP error';
  // Strip anything that looks like credentials from provider messages.
  return raw.replace(/(pass(word)?|user(name)?|auth)[=:]\s*\S+/gi, '$1=[redacted]').slice(0, 300);
}

/**
 * Sends an email through the configured SMTP transport.
 *
 * - The From address is ALWAYS the configured firm identity — callers
 *   (and therefore browsers) can never choose an arbitrary sender.
 * - Reply-To always uses the configured EMAIL_REPLY_TO when present.
 * - Connection, greeting, and socket timeouts are enforced so a hung SMTP
 *   server cannot stall the request indefinitely.
 */
export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const status = getSmtpConfigStatus();
  if (!status.configured) {
    return {
      accepted: false,
      error: `SMTP is not configured. Missing environment variables: ${status.missing.join(', ')}.`,
    };
  }

  const identity = getFirmEmailIdentity();
  const port = Number.parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number.isFinite(port) ? port : 587,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    /**
     * On port 587 (`secure: false`) STARTTLS is negotiated opportunistically by
     * default: if a man-in-the-middle strips the STARTTLS advertisement, the
     * session silently continues in cleartext — exposing the SMTP credentials
     * (AUTH LOGIN base64) and every message body. `requireTLS` makes the send
     * FAIL instead of downgrading.
     *
     * Set SMTP_REQUIRE_TLS=false only for a relay that genuinely cannot do TLS
     * (e.g. a localhost-only development mail catcher); it must never be false
     * for a real provider on a public network.
     */
    requireTLS: (process.env.SMTP_REQUIRE_TLS || 'true').toLowerCase() !== 'false',
    tls: {
      // Refuse protocol versions with known weaknesses.
      minVersion: 'TLSv1.2',
    },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });

  try {
    const info = await transporter.sendMail({
      from: { name: identity.fromName, address: identity.fromAddress },
      to: params.to,
      replyTo: identity.replyTo,
      subject: params.subject,
      text: params.text,
      html: params.html,
    });

    if (!Array.isArray(info.accepted) || info.accepted.length === 0) {
      return { accepted: false, uncertain: true, error: 'Mail server acceptance was not confirmed.' };
    }
    return { accepted: true, providerMessageId: info.messageId || undefined };
  } catch (error) {
    const err = error as { code?: string; responseCode?: number };
    // Timeouts, disconnected sockets and unclassified errors can occur after
    // acceptance. Only explicit SMTP/auth/envelope rejections are definite.
    const transportLost = ['ETIMEDOUT', 'ESOCKET', 'ECONNECTION'].includes(err?.code || '');
    const explicitRejection = !transportLost && (err?.code === 'EAUTH' || err?.code === 'EENVELOPE' || (typeof err?.responseCode === 'number' && err.responseCode >= 500 && err.responseCode < 600));
    return { accepted: false, uncertain: !explicitRejection, error: toSafeSmtpError(error) };
  } finally {
    transporter.close();
  }
}
