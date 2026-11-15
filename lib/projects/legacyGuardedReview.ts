/** The database deliberately marks an ordinary review stale for old clients
 * when an older voucher affects that site. Only legacy-aware workflows may
 * recover the ordinary component, and must still check the legacy coverage. */
export function legacyAwareBaseReview(raw:unknown):unknown {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return raw;
 const v=raw as Record<string,unknown>;
 if(!('legacy_guarded' in v))return raw;
 if(v.legacy_guarded!==true||v.found!==true||v.freshness!=='changed')throw Error('Invalid legacy review guard');
 const {legacy_guarded:_,...rest}=v;
 return {...rest,freshness:'matches'};
}
