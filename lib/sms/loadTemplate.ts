import { validateSMSTemplate } from './templates';
/** Do not silently replace an unavailable saved template with the default. */
export async function loadSMSTemplate(): Promise<string> {
  const response = await fetch('/api/sms/template', {cache:'no-store'});
  if (!response.ok) throw new Error('Could not load the saved SMS template. Try again.');
  const data = await response.json();
  if (typeof data.template !== 'string' || !validateSMSTemplate(data.template).valid) throw new Error('Could not load the saved SMS template. Try again.');
  return data.template;
}
