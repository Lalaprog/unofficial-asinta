import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkspaceHeader } from '@/components/ui/WorkspaceHeader';
import { WorkspaceFilters } from '@/components/ui/WorkspaceFilters';

describe('shared workspace patterns', () => {
  it('provides a page heading, explanatory text and primary action', () => {
    const html = renderToStaticMarkup(React.createElement(WorkspaceHeader, {
      eyebrow: 'Client billing', title: 'Invoices & Billing', description: 'Review client invoices.',
      action: React.createElement('button', { type: 'button' }, 'New Invoice'),
    }));
    expect(html).toContain('<h1');
    expect(html).toContain('Invoices &amp; Billing');
    expect(html).toContain('Review client invoices.');
    expect(html).toContain('New Invoice');
  });

  it('labels the filter region and includes its feedback', () => {
    const html = renderToStaticMarkup(React.createElement(WorkspaceFilters, {
      title: 'Find a project', summary: React.createElement('p', null, '2 results'),
      children: React.createElement('input', { 'aria-label': 'Search projects' }),
    }));
    expect(html).toContain('aria-label="Find a project"');
    expect(html).toContain('aria-label="Search projects"');
    expect(html).toContain('2 results');
  });
});
