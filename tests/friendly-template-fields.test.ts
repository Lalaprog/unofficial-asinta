import { describe, expect, it } from 'vitest';
import { fieldLabel, friendlyField, fromFriendlyTemplate, toFriendlyTemplate } from '@/lib/email/friendlyFields';
import { SUPPORTED_PLACEHOLDERS } from '@/lib/email/templates';
const supported=[...SUPPORTED_PLACEHOLDERS];
describe('friendly billing fields',()=>{
  it('round-trips every supported field while showing readable names',()=>{
    for (const key of supported) {
      const source=`Before {{${key}}} after`;
      const display=toFriendlyTemplate(source,supported);
      expect(display).toContain(friendlyField(key));expect(display).not.toContain(`{{${key}}}`);
      expect(fromFriendlyTemplate(display,supported)).toEqual({ok:true,value:source});
    }
    expect(new Set(supported.map(fieldLabel)).size).toBe(supported.length);
  });
  it('preserves literal brackets and backslashes from existing saved messages',()=>{
    const samples=['Literal ‹Client Name›, not a field','Path C:\\docs\\invoice and ‹word›','\\‹Client Name› {{client_contact_name}}','Text without fields','Unknown {{not_yet_supported}}'];
    for(const source of samples) expect(fromFriendlyTemplate(toFriendlyTemplate(source,supported),supported)).toEqual({ok:true,value:source});
  });
  it('rejects partial and unrecognized fields instead of silently sending their labels',()=>{
    for(const broken of ['Hello ‹Client Nam›','Hello ‹Client Name','Hello Client Name›','‹Invoice Number› and ‹Due›']) expect(fromFriendlyTemplate(broken,supported).ok).toBe(false);
  });
});
