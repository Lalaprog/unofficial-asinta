import {describe,expect,it} from 'vitest';
import {legacyAwareBaseReview} from '@/lib/projects/legacyGuardedReview';

describe('legacy-aware ordinary review marker',()=>{
 it('recovers only the explicitly guarded matching base, without mutating it',()=>{
  const raw={found:true,freshness:'changed',legacy_guarded:true,revision:1};
  expect(legacyAwareBaseReview(raw)).toEqual({found:true,freshness:'matches',revision:1});
  expect(raw.freshness).toBe('changed');
 });
 it('never repairs real stale, unavailable, empty or malformed evidence',()=>{
  for(const raw of [{found:true,freshness:'changed'},{found:true,freshness:'unavailable'},{found:false,latest_revision:0}])expect(legacyAwareBaseReview(raw)).toBe(raw);
  for(const raw of [{found:true,freshness:'unavailable',legacy_guarded:true},{found:true,freshness:'matches',legacy_guarded:true},{found:false,legacy_guarded:true},{found:true,freshness:'changed',legacy_guarded:false}])expect(()=>legacyAwareBaseReview(raw)).toThrow();
 });
});
