import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync('docs/email-templates/SUPABASE_MAGIC_LINK.html', 'utf8');

describe('copy-and-paste Supabase Magic Link email', () => {
  it('uses eight ordered digit boxes only for an eight-character token', () => {
    expect(html).toContain('{{ if eq (len .Token) 8 }}');
    const digits = [...html.matchAll(/\{\{ slice \.Token (\d) (\d) \}\}/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(digits).toEqual(Array.from({ length: 8 }, (_, i) => [i, i + 1]));
    expect(html).toMatch(/\{\{ else \}\}[\s\S]*?\{\{ \.Token \}\}[\s\S]*?\{\{ end \}\}/);
  });

  it('keeps a full copyable code and the existing sign-in link', () => {
    expect(html).toMatch(/For easy copying:[\s\S]*?\{\{ \.Token \}\}/);
    expect(html).toContain('href="{{ .ConfirmationURL }}"');
    expect(html).not.toMatch(/<script\b/i);
    expect(html.match(/<img\b/gi)).toHaveLength(1);
    expect(html).toContain('src="https://unofficial-asinta.vercel.app/brand/asinta-emblem-email.png"');
    expect(readFileSync('public/brand/asinta-emblem-email.png').subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });
});
