export interface ClientFormValues {
  name: string;
  contact_person: string;
  phone: string;
  email: string;
  address: string;
}

/** Never synthesize contact details: those values are used for real outreach. */
export function normalizeClientForm(values: ClientFormValues): ClientFormValues | null {
  const payload = {
    name: values.name.trim(),
    contact_person: values.contact_person.trim(),
    phone: values.phone.trim(),
    email: values.email.trim(),
    address: values.address.trim(),
  };
  return Object.values(payload).every(Boolean) ? payload : null;
}
