import {afterEach,describe,expect,it,vi} from 'vitest';
import * as finance from '@/lib/finance/featureAvailability';
import {ownedEquipmentPreviewEnabled} from '@/lib/tools/ownedEquipment';
import {assignmentHistoryPreviewEnabled} from '@/lib/workforce/assignmentHistory';
import {workerMovePreviewEnabled} from '@/lib/workforce/atomicWorkerMove';
import {categoryPreviewEnabled} from '@/lib/workforce/categoryCatalog';
import {supervisorPortraitPreviewEnabled} from '@/lib/users/supervisorPortrait';

afterEach(()=>vi.unstubAllEnvs());
describe('coordinated development build configuration',()=>{
 it.each([undefined,'','false','TRUE','1'])('does not enable the cutover for %s',value=>{
  vi.stubEnv('NEXT_PUBLIC_DEVELOPMENT_FINANCE_CUTOVER',value);
  expect(finance.developmentFinanceCutoverEnabled()).toBe(false);
  expect(finance.weeklyWorkerCutoverMode()).toBe(false);
  expect(finance.weeklyWorkerActionsPreviewEnabled()).toBe(false);
  expect(finance.weeklyBaleReleasePreviewEnabled()).toBe(false);
  expect(ownedEquipmentPreviewEnabled()).toBe(false);
 });
 it('enables the complete coordinated surfaces but not unrelated categories or portraits',()=>{
  vi.stubEnv('NEXT_PUBLIC_DEVELOPMENT_FINANCE_CUTOVER','true');vi.stubEnv('NEXT_PUBLIC_DEVELOPMENT_CORRECTION_SUPABASE_REF','abcdefghijklmnopqrst');vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://abcdefghijklmnopqrst.supabase.co');
  for(const [name,fn] of Object.entries(finance)){
   expect(fn(),name).toBe(!['supervisorPayrollRevisionPreviewEnabled','projectCostCorrectionPreviewEnabled','correctedProjectCostReviewPreviewEnabled','crossSiteIllustrationPreviewEnabled','crossSiteSourceReviewPreviewEnabled'].includes(name));
  }
  vi.stubEnv('NEXT_PUBLIC_SUPERVISOR_PAYROLL_REVISION_PREVIEW','true');
  expect(finance.supervisorPayrollRevisionPreviewEnabled()).toBe(true);
  vi.stubEnv('NEXT_PUBLIC_PROJECT_COST_CORRECTION_PREVIEW','true');
  expect(finance.projectCostCorrectionPreviewEnabled()).toBe(true);
  expect(finance.correctedProjectCostReviewPreviewEnabled()).toBe(false);
  vi.stubEnv('NEXT_PUBLIC_CORRECTED_PROJECT_COST_REVIEW_PREVIEW','true');
  expect(finance.correctedProjectCostReviewPreviewEnabled()).toBe(true);
  expect(ownedEquipmentPreviewEnabled()).toBe(true);
  expect(assignmentHistoryPreviewEnabled()).toBe(true);
  expect(workerMovePreviewEnabled()).toBe(true);
  expect(categoryPreviewEnabled()).toBe(false);
  expect(supervisorPortraitPreviewEnabled()).toBe(false);
 });
});

describe('development correction target guard',()=>{
 it('fails closed for missing, mismatched or unsafe URLs and enables only the configured exact project',()=>{
  vi.stubEnv('NEXT_PUBLIC_DEVELOPMENT_FINANCE_CUTOVER','true');
  vi.stubEnv('NEXT_PUBLIC_PROJECT_COST_CORRECTION_PREVIEW','true');
  vi.stubEnv('NEXT_PUBLIC_CORRECTED_PROJECT_COST_REVIEW_PREVIEW','true');
  vi.stubEnv('NEXT_PUBLIC_DEVELOPMENT_CORRECTION_SUPABASE_REF','abcdefghijklmnopqrst');
  for(const url of ['', 'not a url','http://abcdefghijklmnopqrst.supabase.co','https://other.supabase.co','https://abcdefghijklmnopqrst.supabase.co.evil.test','https://user@abcdefghijklmnopqrst.supabase.co','https://abcdefghijklmnopqrst.supabase.co/path','https://abcdefghijklmnopqrst.supabase.co/?x=1','https://abcdefghijklmnopqrst.supabase.co/#x']){
   vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL',url);
   expect(finance.projectCostCorrectionPreviewEnabled(),url).toBe(false);
   expect(finance.correctedProjectCostReviewPreviewEnabled(),url).toBe(false);
  }
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://abcdefghijklmnopqrst.supabase.co');
  expect(finance.projectCostCorrectionPreviewEnabled()).toBe(true);
  expect(finance.correctedProjectCostReviewPreviewEnabled()).toBe(true);
  vi.stubEnv('NEXT_PUBLIC_DEVELOPMENT_CORRECTION_SUPABASE_REF','');
  expect(finance.projectCostCorrectionPreviewEnabled()).toBe(false);
 });
});
