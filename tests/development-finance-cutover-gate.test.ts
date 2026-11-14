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
  vi.stubEnv('NEXT_PUBLIC_DEVELOPMENT_FINANCE_CUTOVER','true');
  for(const [name,fn] of Object.entries(finance)){
   expect(fn(),name).toBe(name !== 'supervisorPayrollRevisionPreviewEnabled');
  }
  vi.stubEnv('NEXT_PUBLIC_SUPERVISOR_PAYROLL_REVISION_PREVIEW','true');
  expect(finance.supervisorPayrollRevisionPreviewEnabled()).toBe(true);
  expect(ownedEquipmentPreviewEnabled()).toBe(true);
  expect(assignmentHistoryPreviewEnabled()).toBe(true);
  expect(workerMovePreviewEnabled()).toBe(true);
  expect(categoryPreviewEnabled()).toBe(false);
  expect(supervisorPortraitPreviewEnabled()).toBe(false);
 });
});
