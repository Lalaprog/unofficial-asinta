import {describe,expect,it} from 'vitest';
import {correctionAmount,correctionSplit} from '@/lib/payroll/projectCostCorrection';
const site='55555555-5555-4555-8555-555555555555',other='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
describe('signed correction centavos',()=>{
 it('uses exact integer arithmetic, canonicalizes values and handles balanced zero',()=>{
  expect(correctionAmount('-12.5')).toEqual({text:'-12.50',cents:-1250n});expect(correctionAmount('-0.00').text).toBe('0.00');
  expect(correctionSplit([{project_id:other,gross_change:'-10'},{project_id:site,gross_change:'10'}],'0')).toEqual([{project_id:site,gross_change:'10.00'},{project_id:other,gross_change:'-10.00'}]);expect(correctionSplit([],'0')).toEqual([]);
 });
 it('rejects imprecise, huge, invalid, duplicate and unbalanced splits',()=>{
  for(const x of ['NaN','1e2','01.00','1.001','10000000000','+1','',' 2'])expect(()=>correctionAmount(x)).toThrow();
  expect(()=>correctionSplit([{project_id:site,gross_change:'0'}],'0')).toThrow();expect(()=>correctionSplit([{project_id:site,gross_change:'1'},{project_id:site.toUpperCase(),gross_change:'1'}],'2')).toThrow();expect(()=>correctionSplit([{project_id:site,gross_change:'1'}],'2')).toThrow();
 });
});
