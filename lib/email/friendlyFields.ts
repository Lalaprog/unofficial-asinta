const FIELD_LABELS: Record<string, string> = {
  client_contact_name: 'Client Name',
  client_company_name: 'Client / Company',
  project_name: 'Project Name',
  invoice_number: 'Invoice Number',
  issue_date: 'Invoice Date',
  invoice_amount: 'Invoice Amount',
  amount_paid: 'Amount Paid',
  outstanding_balance: 'Outstanding Balance',
  due_date: 'Due Date',
  invoice_notes: 'Invoice Notes',
  firm_email: 'Firm Email',
  firm_contact_number: 'Firm Contact Number',
};

export const fieldLabel = (field: string) => FIELD_LABELS[field] || field.replace(/_/g, ' ');
export const friendlyField = (field: string) => `‹${fieldLabel(field)}›`;
const tokenPattern = /\{\{([a-z_]+)\}\}/g;
const escapeLiteral = (value: string) => value.replace(/[\\‹›]/g, (match) => `\\${match}`);

/** Render stored tokens as readable fields. Escape literal marker characters
 * so old messages round-trip without turning ordinary text into a field. */
export function toFriendlyTemplate(stored: string, supported: string[]): string {
  let result = '';
  let index = 0;
  for (const match of stored.matchAll(tokenPattern)) {
    const at = match.index!;
    result += escapeLiteral(stored.slice(index, at));
    result += supported.includes(match[1]) ? friendlyField(match[1]) : escapeLiteral(match[0]);
    index = at + match[0].length;
  }
  return result + escapeLiteral(stored.slice(index));
}

export type FriendlyParse = { ok: true; value: string } | { ok: false; error: string };
/** Invalid or partly edited fields fail closed instead of sending a broken label. */
export function fromFriendlyTemplate(display: string, supported: string[]): FriendlyParse {
  const labels = new Map(supported.map((field) => [fieldLabel(field), field]));
  const invalid = { ok: false, error: 'A field was changed or is incomplete. Remove it completely and insert it again.' } as const;
  let result = '';
  for (let i = 0; i < display.length; i++) {
    const char = display[i];
    if (char === '\\' && i + 1 < display.length && ['\\', '‹', '›'].includes(display[i + 1])) {
      result += display[++i];
      continue;
    }
    if (char === '‹') {
      const end = display.indexOf('›', i + 1);
      const label = end < 0 ? '' : display.slice(i + 1, end);
      const field = labels.get(label);
      if (!field) return invalid;
      result += `{{${field}}}`;
      i = end;
      continue;
    }
    if (char === '›') return invalid;
    result += char;
  }
  return { ok: true, value: result };
}
