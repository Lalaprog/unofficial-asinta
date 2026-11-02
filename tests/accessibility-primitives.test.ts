import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

// Configuration-level regression checks: these do not replace checking actual
// rendered combinations, alpha overlays or assistive technology in the browser.
const colors = require('../tailwind.config.js').theme.extend.colors as Record<string, Record<string, string>>;
function luminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)!.map((value) => parseInt(value, 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('shared accessibility primitives', () => {
  it('maintains small-text contrast for semantic status text and backgrounds', () => {
    for (const status of ['success', 'warning', 'danger', 'info']) {
      expect(contrast(colors.status[status], colors.status[`${status}-bg`]), status).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.status[status], '#FFFFFF'), status).toBeGreaterThanOrEqual(4.5);
    }
  });

  const props = { id: 'field', label: 'Field', error: 'Please correct this field.',
    'aria-describedby': 'extra-guidance', 'aria-invalid': false } as const;
  const cases = [
    ['Input', () => React.createElement(Input, props)],
    ['Textarea', () => React.createElement(Textarea, props)],
    ['Select', () => React.createElement(Select, props)],
  ] as const;
  for (const [name, makeElement] of cases) {
    it(`${name} preserves external descriptions alongside field-specific errors`, () => {
      const html = renderToStaticMarkup(makeElement());
      expect(html).toContain('aria-describedby="extra-guidance field-error"');
      expect(html).toContain('aria-invalid="true"');
      expect(html).toContain('id="field-error"');
    });
  }
});
