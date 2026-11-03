/**
 * BALE — Next.js configuration.
 *
 * Security-relevant decisions are documented inline; the surrounding reasoning
 * lives in docs/SECURITY.md so the code and the write-up cannot drift.
 */

const isProduction = process.env.NODE_ENV === 'production';

/** Origin of the Supabase project, derived from the public URL (no secrets). */
function supabaseOrigins() {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return { host: null, https: null, wss: null };
  try {
    const url = new URL(raw);
    return {
      host: url.hostname,
      https: `${url.protocol}//${url.host}`,
      wss: `wss://${url.host}`,
    };
  } catch {
    return { host: null, https: null, wss: null };
  }
}

const supabase = supabaseOrigins();

/**
 * Content Security Policy.
 *
 * `script-src` includes 'unsafe-inline': the App Router streams inline
 * bootstrap/flight scripts and BALE does not use a nonce pipeline. Removing it
 * requires threading a per-request nonce through middleware, which is real work
 * and is tracked in ROADMAP.md rather than faked here. Everything else is
 * locked down — notably `object-src 'none'`, `base-uri 'self'`, and
 * `form-action 'self'`.
 *
 * Frame protection differs by environment on purpose:
 *   - production: `frame-ancestors 'none'` — clickjacking a Founder into
 *     clicking Approve / Record Payment / Send Reminder is the threat.
 *   - development: the sandbox preview embeds the dev server in an iframe on a
 *     `*.e2b.app` origin, and a `'none'` policy would black-screen the preview.
 *     Development therefore allows that wildcard only. The production policy is
 *     what ships.
 */
function contentSecurityPolicy() {
  const supabaseHttps = supabase.https ? ` ${supabase.https}` : '';
  const supabaseWss = supabase.wss ? ` ${supabase.wss}` : '';

  const scriptSrc = isProduction
    ? "'self' 'unsafe-inline'"
    : "'self' 'unsafe-inline' 'unsafe-eval'";

  const connectSrc = isProduction
    ? `'self'${supabaseHttps}${supabaseWss}`
    : `'self'${supabaseHttps}${supabaseWss} ws: wss: http://localhost:*`;

  const frameAncestors = isProduction ? "'none'" : "'self' https://*.e2b.app";

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // Tailwind compiles to a static stylesheet, but Next injects inline
    // <style> blocks for streamed CSS — 'unsafe-inline' is required for styles.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${supabaseHttps}`,
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
    "upgrade-insecure-requests",
  ].join('; ');
}

/**
 * Remote image patterns.
 *
 * `next/image` is not used anywhere in this app and the optimizer is disabled
 * below, so this list exists only to keep the surface closed if someone adds
 * `<Image>` later: Supabase Storage (receipt photos) and the local dev host.
 * The previous `hostname: '**'` allowed the optimizer to fetch any host.
 */
const remotePatterns = [
  { protocol: 'https', hostname: '*.supabase.co', pathname: '/storage/v1/object/**' },
  { protocol: 'http', hostname: 'localhost' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  async redirects() {
    // "/" is the canonical authentication URL. Legacy login portals redirect
    // permanently (308); the middleware provides the same guarantee as a
    // fallback for any other /login/* path.
    return [
      { source: '/login', destination: '/', permanent: true },
      { source: '/login/:path*', destination: '/', permanent: true },
    ];
  },

  images: {
    /**
     * The image optimizer is pure attack surface here.
     *
     * Next 14.2.35 carries GHSA-2xp9-vwfh-vxw4 (CVSS 9.5) — unauthenticated
     * RCE through the AVIF decode path (libheif/sharp) — with no patched 14.x
     * release. `sharp` is not installed and no component uses `next/image`, so
     * nothing in the app loses a feature by turning optimization off. The real
     * fix is the Next 16 upgrade tracked in ROADMAP.md; this closes the reachable
     * hole today.
     */
    unoptimized: true,
    remotePatterns,
  },

  async headers() {
    const securityHeaders = [
      { key: 'Content-Security-Policy', value: contentSecurityPolicy() },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      // Clickjacking is the concrete risk: a framed Founder clicking Approve.
      // `DENY` is redundant with frame-ancestors in production but is kept for
      // older browsers that ignore CSP frame-ancestors.
      ...(isProduction
        ? [
            { key: 'X-Frame-Options', value: 'DENY' },
            {
              key: 'Strict-Transport-Security',
              value: 'max-age=63072000; includeSubDomains; preload',
            },
          ]
        : []),
      {
        key: 'Permissions-Policy',
        // Receipt capture uses <input capture>, not the Camera API.
        value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      },
      { key: 'X-DNS-Prefetch-Control', value: 'off' },
    ];

    return [
      {
        // Apply to every response, including API routes and static assets.
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

module.exports = nextConfig;
