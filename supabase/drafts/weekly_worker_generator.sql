-- DRAFT ONLY. This creates frozen, non-payable weekly draft vouchers in a
-- coordinated test database; it is NOT a release migration. It depends on all
-- weekly preview/time-detail/allowance migrations and the legacy payroll table.
-- No existing voucher is replaced, refreshed, approved, paid or deleted.
-- Until an approval path checks the source snapshot and coordinates the payment
-- and allocation cutover, generated vouchers are intentionally non-payable.
-- Its table-level locks temporarily block unrelated source writes and require
-- load/deadlock review before a hosted deployment; never apply in production as-is.

CREATE TABLE public.weekly_worker_draft_sources (
  payroll_id uuid PRIMARY KEY REFERENCES public.payroll(id) ON DELETE RESTRICT,
  worker_id uuid NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
  period_start date NOT NULL,
  recorded_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source_snapshot jsonb NOT NULL,
  calculation jsonb NOT NULL,
  UNIQUE (worker_id,period_start)
);
ALTER TABLE public.weekly_worker_draft_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.weekly_worker_draft_sources FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.weekly_worker_draft_sources TO authenticated;
CREATE POLICY founder_reads_weekly_worker_draft_sources ON public.weekly_worker_draft_sources
 FOR SELECT TO authenticated USING (coalesce(public.is_founder(),false) AND coalesce(public.session_assurance_satisfied(),false));
DO $$ BEGIN
 IF has_table_privilege('anon','public.weekly_worker_draft_sources','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 OR has_table_privilege('authenticated','public.weekly_worker_draft_sources','INSERT,UPDATE,DELETE,TRUNCATE')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.weekly_worker_draft_sources'::regclass AND a.attnum>0 AND NOT a.attisdropped AND
  (has_column_privilege('anon',a.attrelid,a.attname,'SELECT,INSERT,UPDATE') OR has_column_privilege('authenticated',a.attrelid,a.attname,'INSERT,UPDATE'))) THEN
  RAISE EXCEPTION 'Unexpected inherited privileges on weekly draft sources'; END IF;
END $$;

-- Existing clients can edit drafts and call legacy approval. Neither is safe
-- for these source-bound vouchers. Do not relax this without atomic source
-- revalidation, finalized-input protection and the coordinated payment path.
CREATE FUNCTION public.guard_weekly_worker_draft()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.weekly_worker_draft_sources s WHERE s.payroll_id=OLD.id) THEN
  RAISE EXCEPTION 'Weekly source-bound draft is frozen pending the reviewed approval workflow' USING ERRCODE='22023';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_weekly_worker_draft() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_weekly_worker_draft BEFORE UPDATE OR DELETE ON public.payroll
 FOR EACH ROW EXECUTE FUNCTION public.guard_weekly_worker_draft();

-- Private evidence check. A pre-entered future day is not completed work or a
-- confirmed future disbursement. Never silently convert it to a payable wage.
CREATE FUNCTION public.weekly_worker_source_has_future(p_sources jsonb,p_today date) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(p_sources->'attendance') a WHERE (a->'record'->>'date')::date>p_today)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_sources->'allowances') a WHERE a->>'status'<>'rejected' AND (a->>'attendance_date')::date>p_today)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_sources->'advances') a WHERE a->'advance'->>'status'<>'cancelled' AND (a->'advance'->>'date')::date>p_today)
$$;
REVOKE ALL ON FUNCTION public.weekly_worker_source_has_future(jsonb,date) FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_function_privilege(r.role_name,'public.weekly_worker_source_has_future(jsonb,date)','EXECUTE')) THEN RAISE EXCEPTION 'Unexpected inherited weekly source helper privilege'; END IF; END $$;

CREATE FUNCTION public.create_weekly_worker_draft(p_id uuid,p_worker uuid,p_start date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_snapshot jsonb; v_worker jsonb; v_att jsonb; v_allow jsonb; v_adv jsonb; v_old jsonb;
 v_entry jsonb; v_item jsonb; v_detail jsonb; v_regular numeric:=0; v_ot numeric:=0;
 v_day_regular numeric; v_day_ot numeric; v_allowance numeric:=0; v_bale numeric:=0;
 v_rate numeric; v_wage numeric; v_gross numeric; v_net numeric; v_days numeric;
 v_unmarked jsonb; v_sources jsonb; v_calculation jsonb; v_prev public.weekly_worker_draft_sources%ROWTYPE;
 v_pay public.payroll%ROWTYPE; v_email text; v_dates date[]:='{}';
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Weekly generation requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL OR p_worker IS NULL OR p_start IS NULL OR p_start<DATE '1900-01-01' OR p_start>DATE '9998-12-24' OR extract(dow FROM p_start)<>0 THEN
  RAISE EXCEPTION 'Choose a worker, a Sunday, and a request ID' USING ERRCODE='22023'; END IF;
 -- All source snapshots and duplicate checks must precede a single insert.
 -- Lock order is deliberately global and conservative; bound waiting, allow
 -- deadlock abort/retry, and test old client interactions before rollout.
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.attendance,public.attendance_time_details,
   public.worker_allowances,public.advances,public.advance_requests,public.payroll
   IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO v_prev FROM public.weekly_worker_draft_sources WHERE payroll_id=p_id;
 IF FOUND THEN
  IF (v_prev.worker_id,v_prev.period_start,v_prev.recorded_by) IS DISTINCT FROM (p_worker,p_start,auth.uid()) THEN
   RAISE EXCEPTION 'Draft ID already used for another request' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('replayed',true,'payroll_id',p_id,'calculation',v_prev.calculation);
 END IF;
 IF EXISTS(SELECT 1 FROM public.payroll WHERE id=p_id) OR EXISTS(SELECT 1 FROM public.weekly_worker_draft_sources WHERE worker_id=p_worker AND period_start=p_start) THEN
  RAISE EXCEPTION 'An existing voucher or weekly draft requires review; no record was overwritten' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.payroll p WHERE p.worker_id=p_worker AND p.period_start<=p_start+6 AND p.period_end>=p_start) THEN
  RAISE EXCEPTION 'An existing overlapping voucher requires review; no record was overwritten' USING ERRCODE='22023'; END IF;
 v_snapshot:=public.weekly_worker_preview_inputs(p_start);
 IF coalesce(jsonb_typeof(v_snapshot),'')<>'object' OR v_snapshot->>'start' IS DISTINCT FROM p_start::text OR v_snapshot->>'end' IS DISTINCT FROM (p_start+6)::text
   OR coalesce(jsonb_typeof(v_snapshot->'workers'),'')<>'array'
   OR coalesce(jsonb_typeof(v_snapshot->'attendance'),'')<>'array'
   OR coalesce(jsonb_typeof(v_snapshot->'allowances'),'')<>'array'
   OR coalesce(jsonb_typeof(v_snapshot->'advances'),'')<>'array'
   OR coalesce(jsonb_typeof(v_snapshot->'older_advances'),'')<>'array' THEN
  RAISE EXCEPTION 'Incomplete weekly inputs; no voucher was created' USING ERRCODE='22023'; END IF;
 SELECT value INTO v_worker FROM jsonb_array_elements(v_snapshot->'workers') WHERE value->>'id'=p_worker::text;
 IF v_worker IS NULL OR coalesce((v_worker->>'linked_supervisor')::boolean,true) OR coalesce((v_worker->>'possible_supervisor')::boolean,true) THEN
  RAISE EXCEPTION 'Worker unavailable or possible Supervisor identity requires review' USING ERRCODE='22023'; END IF;
 IF coalesce(v_worker->>'pay_rate_type','') NOT IN ('daily','hourly') OR coalesce(v_worker->>'pay_rate','') !~ '^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$' THEN
  RAISE EXCEPTION 'Invalid worker rate' USING ERRCODE='22023'; END IF;
 v_rate:=(v_worker->>'pay_rate')::numeric;
 SELECT coalesce(jsonb_agg(x.value ORDER BY x.value->>'date',x.value->>'id'),'[]'::jsonb) INTO v_att
 FROM jsonb_array_elements(v_snapshot->'attendance') x WHERE x.value->>'worker_id'=p_worker::text;
 IF jsonb_array_length(v_att)=0 THEN RAISE EXCEPTION 'No marked attendance; unmarked does not mean absent' USING ERRCODE='22023'; END IF;
 FOR v_entry IN SELECT value FROM jsonb_array_elements(v_att) LOOP
  IF coalesce(v_entry->>'id','')='' OR coalesce(v_entry->>'project_id','')=''
   OR coalesce(v_entry->>'hours_worked','') !~ '^(0|[1-9][0-9]{0,1})(\.[0-9]{1,2})?$'
   OR v_entry->>'date' IS NULL OR (v_entry->>'date')::date NOT BETWEEN p_start AND p_start+6 OR (v_entry->>'date')::date=ANY(v_dates) THEN
   RAISE EXCEPTION 'Conflicting attendance dates require review' USING ERRCODE='22023'; END IF;
  v_dates:=array_append(v_dates,(v_entry->>'date')::date);
  v_detail:=v_entry->'time_detail';
  IF v_detail IS NULL THEN RAISE EXCEPTION 'Incomplete time detail response' USING ERRCODE='22023'; END IF;
  IF v_entry->>'status' IN ('present','half_day') THEN
   IF v_detail='null'::jsonb THEN v_day_regular:=(v_entry->>'hours_worked')::numeric;v_day_ot:=0;
   ELSE
    IF coalesce((v_detail->>'stale')::boolean,true) THEN RAISE EXCEPTION 'Stale time details require review' USING ERRCODE='22023'; END IF;
    v_day_regular:=(v_detail->>'regular_hours')::numeric;v_day_ot:=(v_detail->>'overtime_hours')::numeric;
   END IF;
   IF v_day_regular IS NULL OR v_day_ot IS NULL OR v_day_regular='NaN'::numeric OR v_day_ot='NaN'::numeric
      OR v_day_regular<0 OR v_day_regular>8 OR v_day_ot<0 OR v_day_regular+v_day_ot<=0 OR v_day_regular+v_day_ot>24 THEN
    RAISE EXCEPTION 'Recorded hours require review' USING ERRCODE='22023'; END IF;
   v_regular:=v_regular+v_day_regular;v_ot:=v_ot+v_day_ot;
  ELSIF v_entry->>'status' IN ('absent','leave') THEN
   IF (v_entry->>'hours_worked')::numeric<>0 OR v_detail<>'null'::jsonb THEN RAISE EXCEPTION 'Unworked attendance requires review' USING ERRCODE='22023'; END IF;
  ELSE RAISE EXCEPTION 'Invalid attendance status' USING ERRCODE='22023'; END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(x.value ORDER BY x.value->>'id'),'[]'::jsonb) INTO v_allow
 FROM jsonb_array_elements(v_snapshot->'allowances') x WHERE x.value->>'worker_id'=p_worker::text;
 FOR v_item IN SELECT value FROM jsonb_array_elements(v_allow) LOOP
  IF coalesce(v_item->>'id','')='' OR coalesce(v_item->>'project_id','')='' OR coalesce(v_item->>'date','')=''
    OR coalesce(v_item->>'description','')='' OR coalesce(v_item->>'status','') NOT IN ('pending','approved','rejected')
    OR coalesce(v_item->>'amount','') !~ '^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$' THEN
   RAISE EXCEPTION 'Incomplete allowance requires review' USING ERRCODE='22023'; END IF;
  IF v_item->>'status'='pending' OR (v_item->>'status'='approved' AND coalesce((v_item->>'stale')::boolean,true)) THEN
   RAISE EXCEPTION 'Pending or stale allowance requires review' USING ERRCODE='22023'; END IF;
  IF v_item->>'status'='approved' THEN
   IF (v_item->>'amount')::numeric<=0 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_att) a WHERE a->>'project_id'=v_item->>'project_id'
     AND a->>'date'=v_item->>'date' AND a->>'status' IN ('present','half_day')) THEN
    RAISE EXCEPTION 'Allowance does not match worked attendance' USING ERRCODE='22023'; END IF;
   v_allowance:=v_allowance+(v_item->>'amount')::numeric;
  ELSIF v_item->>'status'<>'rejected' THEN RAISE EXCEPTION 'Invalid allowance state' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_allow) a WHERE a->>'status'<>'rejected'
  GROUP BY a->>'date',a->>'project_id',(a->>'amount')::numeric,lower(btrim(a->>'description')) HAVING count(*)>1) THEN
  RAISE EXCEPTION 'Possible duplicate allowance requires review' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(x.value ORDER BY x.value->>'id'),'[]'::jsonb) INTO v_adv
 FROM jsonb_array_elements(v_snapshot->'advances') x WHERE x.value->>'worker_id'=p_worker::text;
 SELECT coalesce(jsonb_agg(x.value ORDER BY x.value->>'id'),'[]'::jsonb) INTO v_old
 FROM jsonb_array_elements(v_snapshot->'older_advances') x WHERE x.value->>'worker_id'=p_worker::text;
 IF jsonb_array_length(v_old)>0 THEN RAISE EXCEPTION 'Older outstanding Bale requires separate review, not carry-forward' USING ERRCODE='22023'; END IF;
 FOR v_item IN SELECT value FROM jsonb_array_elements(v_adv) LOOP
  IF coalesce(v_item->>'id','')='' OR coalesce(v_item->>'project_id','')='' OR coalesce(v_item->>'date','')=''
    OR coalesce(v_item->>'status','') NOT IN ('active','partially_deducted','fully_deducted','cancelled')
    OR coalesce(v_item->>'amount','') !~ '^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$'
    OR coalesce(v_item->>'deducted','') !~ '^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$' THEN
   RAISE EXCEPTION 'Incomplete Bale requires review' USING ERRCODE='22023'; END IF;
  IF v_item->>'status'='cancelled' THEN
   IF (v_item->>'deducted')::numeric<>0 THEN RAISE EXCEPTION 'Cancelled Bale with deductions requires review' USING ERRCODE='22023'; END IF;
  ELSIF v_item->>'status'<>'active' OR (v_item->>'deducted')::numeric<>0 OR NOT coalesce((v_item->>'linked_release')::boolean,false)
    OR extract(dow FROM (v_item->>'date')::date)<>3 OR (v_item->>'amount')::numeric<=0 THEN
   RAISE EXCEPTION 'Bale release, timing or previous deduction requires review' USING ERRCODE='22023';
  ELSE v_bale:=v_bale+(v_item->>'amount')::numeric;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_adv) a WHERE a->>'status'<>'cancelled'
  GROUP BY a->>'project_id',a->>'date',(a->>'amount')::numeric HAVING count(*)>1) THEN
  RAISE EXCEPTION 'Possible duplicate Bale requires review' USING ERRCODE='22023'; END IF;
 IF v_bale>0 AND EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=p_worker AND a.date>p_start+6 AND a.status IN ('active','partially_deducted')) THEN
  RAISE EXCEPTION 'Outstanding Bale outside this period requires review, not carry-forward' USING ERRCODE='22023'; END IF;
 v_wage:=round(v_rate*(v_regular+v_ot)/CASE WHEN v_worker->>'pay_rate_type'='daily' THEN 8 ELSE 1 END,2);
 v_gross:=v_wage+v_allowance;v_net:=v_gross-v_bale;v_days:=round(v_regular/8,2);
 IF v_net<0 OR v_gross>=100000000 OR v_bale>=100000000 THEN RAISE EXCEPTION 'Bale exceeds earnings or amount exceeds voucher limit; review required' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(d::date ORDER BY d),'[]'::jsonb) INTO v_unmarked
 FROM generate_series(p_start::timestamp,(p_start+6)::timestamp,interval '1 day') d WHERE NOT d::date=ANY(v_dates);
 v_calculation:=jsonb_build_object('regular_hours',v_regular::numeric(10,2)::text,'overtime_hours',v_ot::numeric(10,2)::text,'wage',v_wage::numeric(10,2)::text,
  'allowance',v_allowance::numeric(10,2)::text,'gross',v_gross::numeric(10,2)::text,'bale',v_bale::numeric(10,2)::text,'net',v_net::numeric(10,2)::text,'unmarked_dates',v_unmarked);
 -- Preserve raw provenance including exact source snapshots and revisions.
 v_sources:=jsonb_build_object('version',1,'worker',v_worker,'attendance',
  (SELECT coalesce(jsonb_agg(jsonb_build_object('record',to_jsonb(a),'latest_detail',d.detail) ORDER BY a.date,a.id),'[]'::jsonb)
   FROM public.attendance a LEFT JOIN LATERAL (SELECT to_jsonb(t) detail FROM public.attendance_time_details t WHERE t.attendance_id=a.id ORDER BY t.revision_id DESC LIMIT 1) d ON true
   WHERE a.worker_id=p_worker AND a.date BETWEEN p_start AND p_start+6),
  'allowances',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM public.worker_allowances a WHERE a.worker_id=p_worker AND a.attendance_date BETWEEN p_start AND p_start+6),
  'advances',(SELECT coalesce(jsonb_agg(jsonb_build_object('advance',to_jsonb(a),'request',to_jsonb(r)) ORDER BY a.id),'[]'::jsonb) FROM public.advances a LEFT JOIN public.advance_requests r ON r.issued_advance_id=a.id WHERE a.worker_id=p_worker AND a.date BETWEEN p_start AND p_start+6));
 IF octet_length(v_sources::text)>1048576 THEN RAISE EXCEPTION 'Source snapshot is too large; review before generation' USING ERRCODE='54000'; END IF;
 IF public.weekly_worker_source_has_future(v_sources,(statement_timestamp() AT TIME ZONE 'Asia/Manila')::date) THEN RAISE EXCEPTION 'Future-dated attendance, allowance or Bale requires review before generation' USING ERRCODE='22023'; END IF;
 INSERT INTO public.payroll(id,worker_id,period_start,period_end,gross_pay,bale_deduction,other_deductions,net_pay,status,days_worked,hours_worked,notes)
 VALUES(p_id,p_worker,p_start,p_start+6,v_gross,v_bale,0,v_net,'draft',v_days,v_regular+v_ot,'Weekly source-bound draft; approval workflow not yet available') RETURNING * INTO v_pay;
 INSERT INTO public.weekly_worker_draft_sources(payroll_id,worker_id,period_start,recorded_by,source_snapshot,calculation)
 VALUES(p_id,p_worker,p_start,auth.uid(),v_sources,v_calculation);
 SELECT email INTO v_email FROM public.users WHERE id=auth.uid();
 INSERT INTO public.audit_log(actor_id,actor_email,action,table_name,record_id,before_row,after_row)
 VALUES(auth.uid(),v_email,'insert','payroll',p_id,NULL,to_jsonb(v_pay));
 RETURN jsonb_build_object('replayed',false,'payroll_id',p_id,'calculation',v_calculation);
END;
$$;
REVOKE ALL ON FUNCTION public.create_weekly_worker_draft(uuid,uuid,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.create_weekly_worker_draft(uuid,uuid,date) TO authenticated;
