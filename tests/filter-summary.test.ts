import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FilterSummary } from '@/components/ui/FilterSummary';

describe('list filter feedback', () => {
  it('shows the result count without a reset action when no filters are active', () => {
    const html = renderToStaticMarkup(React.createElement(FilterSummary, { count: 1, itemName: "invoice", active: false, onClear: () => {} }));
    expect(html).toContain('1 invoice result');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('Clear filters');
  });

  it('provides an accessible reset action when filters are active', () => {
    const onClear = vi.fn();
    const element = FilterSummary({ count: 0, itemName: 'project', active: true, onClear }) as React.ReactElement;
    const html = renderToStaticMarkup(element);
    expect(html).toContain('0 project results');
    expect(html).toContain('Filters applied');
    expect(html).toContain('Clear filters');
    expect(html).toContain('type="button"');
    const children = React.Children.toArray(element.props.children) as React.ReactElement[];
    children[1].props.onClick();
    expect(onClear).toHaveBeenCalledOnce();
  });
});
