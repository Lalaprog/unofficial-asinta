import {afterEach,describe,expect,it,vi} from 'vitest';
import {baleSubmissionTargetBlocked} from '@/lib/attendance/baleSubmissionTarget';

afterEach(()=>vi.unstubAllEnvs());
describe('development Bale submission target',()=>{
 it('holds enabled retries unless the exact configured development project is used',()=>{
  vi.stubEnv('NEXT_PUBLIC_DEVELOPMENT_FINANCE_CUTOVER','true');
  vi.stubEnv('NEXT_PUBLIC_DEVELOPMENT_BALE_SUPABASE_REF','abcdefghijklmnopqrst');
  for(const url of ['', 'invalid', 'http://abcdefghijklmnopqrst.supabase.co', 'https://other.supabase.co', 'https://abcdefghijklmnopqrst.supabase.co.evil.test', 'https://user@abcdefghijklmnopqrst.supabase.co', 'https://abcdefghijklmnopqrst.supabase.co/path', 'https://abcdefghijklmnopqrst.supabase.co/?x=1']){
   vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL',url);expect(baleSubmissionTargetBlocked(true),url).toBe(true);
  }
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://abcdefghijklmnopqrst.supabase.co');
  expect(baleSubmissionTargetBlocked(true)).toBe(false);
  vi.stubEnv('NEXT_PUBLIC_DEVELOPMENT_BALE_SUPABASE_REF','');expect(baleSubmissionTargetBlocked(true)).toBe(true);
 });
 it('does not alter other rollout modes',()=>{
  vi.stubEnv('NEXT_PUBLIC_DEVELOPMENT_FINANCE_CUTOVER','true');expect(baleSubmissionTargetBlocked(false)).toBe(false);
  vi.stubEnv('NEXT_PUBLIC_DEVELOPMENT_FINANCE_CUTOVER','false');expect(baleSubmissionTargetBlocked(true)).toBe(false);
 });
});
