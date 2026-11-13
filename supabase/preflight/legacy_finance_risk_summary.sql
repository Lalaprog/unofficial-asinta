-- READ ONLY, aggregate signals for legacy payroll/Bale cutover review.
-- Requires the existing public.payroll, advances and advance_requests columns.
-- Run as an authorized operator with complete visibility (not an RLS-limited
-- client); no IDs, names, amounts or source rows are returned. One statement
-- gives a consistent snapshot, but it may become stale immediately. Overlaps,
-- nonweekly periods and differing linked amounts are REVIEW SIGNALS, not proof
-- of an error or duplicate payment; e.g. Supervisor periods are not weekly.
-- This is not a payment ledger, identity check, approval or migration script.
WITH ordered_payroll AS (
 SELECT p.*,
  max(period_end) OVER (PARTITION BY worker_id ORDER BY period_start,period_end,id
    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS earlier_end
 FROM public.payroll p WHERE period_start<=period_end
), duplicate_request_links AS (
 SELECT issued_advance_id FROM public.advance_requests
 WHERE issued_advance_id IS NOT NULL GROUP BY issued_advance_id HAVING count(*)>1
)
SELECT jsonb_build_object(
 'payroll_rows',(SELECT count(*) FROM public.payroll),
 'paid_payroll_rows',(SELECT count(*) FROM public.payroll WHERE status='paid'),
 'payroll_invalid_period_rows',(SELECT count(*) FROM public.payroll WHERE period_start>period_end),
 'payroll_rows_overlapping_earlier_period',(SELECT count(*) FROM ordered_payroll WHERE earlier_end>=period_start),
 'payroll_non_sunday_saturday_period_rows',(SELECT count(*) FROM public.payroll WHERE extract(dow FROM period_start)<>0 OR period_end<>period_start+6),
 'payroll_arithmetic_mismatch_rows',(SELECT count(*) FROM public.payroll WHERE gross_pay-bale_deduction-other_deductions IS DISTINCT FROM net_pay),
 'advance_rows',(SELECT count(*) FROM public.advances),
 'advance_deduction_exceeds_amount_rows',(SELECT count(*) FROM public.advances WHERE amount_deducted>amount),
 'advance_status_balance_mismatch_rows',(SELECT count(*) FROM public.advances WHERE (status='active' AND amount_deducted<>0) OR (status='partially_deducted' AND (amount_deducted<=0 OR amount_deducted>=amount)) OR (status='fully_deducted' AND amount_deducted<>amount)),
 'advance_request_rows',(SELECT count(*) FROM public.advance_requests),
 'issued_request_missing_advance_rows',(SELECT count(*) FROM public.advance_requests r LEFT JOIN public.advances a ON a.id=r.issued_advance_id WHERE r.status='issued' AND a.id IS NULL),
 'nonissued_request_with_advance_link_rows',(SELECT count(*) FROM public.advance_requests WHERE status<>'issued' AND issued_advance_id IS NOT NULL),
 'issued_request_link_details_differ_rows',(SELECT count(*) FROM public.advance_requests r JOIN public.advances a ON a.id=r.issued_advance_id WHERE r.status='issued' AND (r.worker_id,r.project_id,r.requested_amount) IS DISTINCT FROM (a.worker_id,a.project_id,a.amount)),
 'advance_ids_linked_by_multiple_requests',(SELECT count(*) FROM duplicate_request_links)
) AS finance_risk_summary;
