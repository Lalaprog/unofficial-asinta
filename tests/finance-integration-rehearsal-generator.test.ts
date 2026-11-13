import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const generator='scripts/build-finance-integration-rehearsal.mjs';
const names=['guard_legacy_bale_payment','weekly_payment_date','weekly_worker_generator','weekly_worker_approval','weekly_worker_paid_allocation','weekly_worker_draft_details','weekly_paid_attendance_change_review','weekly_worker_draft_refresh','weekly_worker_return_to_draft','weekly_bale_schedule','weekly_bale_expiration','weekly_bale_release_list','weekly_bale_status_batch','weekly_bale_scheduler','attendance_history_time_batch','supervisor_leave_notification','project_paid_payroll_evidence','paid_payroll_adjustments','supervisor_payroll_preview','historical_paid_date_annotation','historical_settled_bale_evidence','historical_finance_evidence_review','historical_external_worker_payroll','supervisor_payroll_ledger','paid_period_assertion_adjustments','confirmed_rental_expense_link','project_cost_reconciliation_preview'];
describe('synthetic finance rehearsal generator',()=>{
 it('includes the reviewed candidate inputs in order, with hashes and an unconditional rollback',()=>{
  const output=execFileSync('node',[generator],{encoding:'utf8'});
  expect(output).toMatch(/^-- REHEARSAL ONLY/);expect(output).toContain('synthetic_finance_rehearsal_marker');expect(output).toMatch(/ROLLBACK;\n$/);
  expect(output.match(/^BEGIN;$/gm)).toHaveLength(1);expect(output.match(/^ROLLBACK;$/gm)).toHaveLength(1);expect(output.match(/^COMMIT;$/gm)).toBeNull();
  let previous=0;for(const name of names){const source=readFileSync(`supabase/drafts/${name}.sql`,'utf8');const digest=createHash('sha256').update(source).digest('hex');const section=`-- Draft: ${name}.sql SHA-256 ${digest}\n${source}`;const position=output.indexOf(section);expect(position).toBeGreaterThan(previous);previous=position;}
  expect(output).toContain('DO $finance_postflight$');
 });
 it('does not offer a commit or deployment option',()=>{const result=spawnSync('node',[generator,'--commit'],{encoding:'utf8'});expect(result.status).not.toBe(0);expect(result.stdout).toBe('');expect(result.stderr).toMatch(/No options or deployment mode/);});
});
