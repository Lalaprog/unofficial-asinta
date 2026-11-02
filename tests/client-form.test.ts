import { describe, expect, it } from 'vitest';
import { normalizeClientForm } from '@/lib/clients/form';

const client = { name: ' Company ', contact_person: ' Contact ', phone: ' 09171234567 ', email: ' person@example.com ', address: ' Batangas ' };

describe('client contact form', () => {
  it('trims real values without manufacturing placeholder contact details', () => {
    expect(normalizeClientForm(client)).toEqual({ name: 'Company', contact_person: 'Contact', phone: '09171234567', email: 'person@example.com', address: 'Batangas' });
  });
  it.each(['name', 'contact_person', 'phone', 'email', 'address'] as const)('rejects blank %s', (field) => {
    expect(normalizeClientForm({ ...client, [field]: '   ' })).toBeNull();
  });
});
