import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

describe('development cutover bundle',()=>{
 it('matches its reviewed sources and keeps the staged preflight and old-writer guards',()=>{
  const generated=execFileSync('node',['scripts/build-development-finance-cutover.mjs'],{encoding:'utf8'});
  expect(readFileSync('supabase/release/development-finance-cutover.sql','utf8')).toBe(generated);
  expect(generated).toContain('Development business records exist; reconcile before cutover');
  expect(generated).toContain("md5(prosrc)='9e005a393f9295f31e5724906b46b08e'");
  expect(generated).toContain('supabase/drafts/weekly_worker_legacy_cutover_guard.sql');
  expect(generated).toContain('supabase/drafts/weekly_bale_legacy_cutover_guard.sql');
  expect(generated).toContain('supabase/drafts/attendance_assignment_guard.sql');
  expect(generated).toContain('supabase/drafts/owned_equipment_allocations.sql');
  expect(generated).toContain('GRANT EXECUTE ON FUNCTION public.record_attendance_time_detail');
  expect(generated).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
 });
});
