import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('document printing',()=>{
 it('marks only invoice and payslip content as the print document',()=>{
  const invoice=readFileSync('app/invoices/page.tsx','utf8');const payroll=readFileSync('app/payroll/page.tsx','utf8');
  expect(invoice).toContain('data-print-document="invoice"');expect(payroll).toContain('data-print-document="payslip"');
  expect(invoice).toContain('window.print()');expect(payroll).toContain('window.print()');
  const css=readFileSync('app/globals.css','utf8');expect(css).toContain('body:has([data-print-document])');expect(css).toContain('display: none !important');expect(css).toContain('overflow: visible !important');
 });
});
