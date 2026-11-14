import {describe,expect,it} from 'vitest';
import {parseCrossSiteEvidence,verifyCrossSiteIllustration} from '@/lib/payroll/crossSiteIllustration';
import {correctionItem,expected,makeEvidence,other,externalItem,makeExternalEvidence,correctionReview,externalReview} from './helpers/cross-site-illustration-fixture';
const parse=(value:unknown)=>parseCrossSiteEvidence(value,'voucher',correctionItem,correctionReview());
describe('cross-site illustration exact arithmetic',()=>{
 it('independently calculates and verifies all sites without adding a project total',()=>{const parsed=parse(makeEvidence());expect(parsed.illustration).toEqual(expected);expect(verifyCrossSiteIllustration(expected,parsed.illustration)).toEqual(expected);expect(()=>verifyCrossSiteIllustration({...expected,corrected_gross:'0.00'},parsed.illustration)).toThrow();expect(()=>verifyCrossSiteIllustration({...expected,sites:expected.sites.slice(0,1)},parsed.illustration)).toThrow();});
 it('rejects missing, inconsistent, duplicate, negative and stale evidence',()=>{
  const values=[];
  let x=makeEvidence();x.original.sites=[];values.push(x);
  x=makeEvidence();x.original.sites.push({...x.original.sites[0]});values.push(x);
  x=makeEvidence();x.original.sites[0].gross='599.99';values.push(x);
  x=makeEvidence();x.original.source_id=other;values.push(x);
  x=makeEvidence();x.correction.attribution.case_changed=true;values.push(x);
  x=makeEvidence();x.original.case_snapshot.reason='Different';values.push(x);
  x=makeEvidence();x.correction.attribution.split[0].gross_change='-601.00';x.correction.attribution.split[1].gross_change='601.00';values.push(x);
  x=makeEvidence();x.correction.case.related_cases.push({...x.correction.case.related_cases[0],id:other});x.original.case_snapshot=structuredClone(x.correction.case);x.correction.attribution.case_snapshot=structuredClone(x.correction.case);values.push(x);
  for(const value of values)expect(()=>parse(value)).toThrow();
 });
 it('independently verifies an externally paid worker assertion as evidence only',()=>{const result=parseCrossSiteEvidence(makeExternalEvidence(),'external_worker',externalItem,externalReview());expect(result.illustration).toEqual({...expected,source_kind:'external_worker'});});
 it('rejects malformed amounts, mismatched results and oversized snapshots',()=>{
  const x=makeEvidence();x.original.sites[0].gross='6e2';expect(()=>parse(x)).toThrow();
  expect(()=>parse({...makeEvidence(),extra:'x'.repeat(262145)})).toThrow();
  expect(()=>verifyCrossSiteIllustration({...expected,incomplete:false},expected as ReturnType<typeof parse>['illustration'])).toThrow();
 });
});
