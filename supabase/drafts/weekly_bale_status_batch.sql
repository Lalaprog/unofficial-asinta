-- DRAFT ONLY: requires the reviewed weekly Bale schedule and expiry drafts.
-- Bounded status enrichment for IDs already visible in the existing request
-- list. Founder sees all; Supervisor sees only their own submissions, matching
-- existing request RLS. Missing or unauthorized IDs fail the entire request.
-- This read function does not run or schedule expiry.
CREATE FUNCTION public.weekly_bale_status_batch(p_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_now timestamptz:=public.weekly_bale_clock(); v_date date:=(v_now AT TIME ZONE 'Asia/Manila')::date;
 v_founder boolean; v_role text; v_count integer; v_items jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Authorized access required' USING ERRCODE='42501'; END IF;
 v_founder:=coalesce(public.is_founder(),false);v_role:=public.current_user_role();
 IF NOT v_founder AND v_role IS DISTINCT FROM 'supervisor' THEN RAISE EXCEPTION 'Authorized access required' USING ERRCODE='42501'; END IF;
 IF p_ids IS NULL OR cardinality(p_ids)>500 OR EXISTS(SELECT 1 FROM unnest(p_ids) x WHERE x IS NULL)
  OR cardinality(p_ids)<>(SELECT count(DISTINCT x) FROM unnest(p_ids) x) THEN RAISE EXCEPTION 'Invalid request ID list' USING ERRCODE='22023'; END IF;
 SELECT count(*)::integer,coalesce(jsonb_agg(jsonb_build_object('id',r.id,'stored_status',r.status,
  'kind',CASE WHEN w.request_id IS NULL THEN 'legacy' ELSE 'weekly' END,'period_start',w.period_start,
  'effective_status',CASE WHEN w.request_id IS NOT NULL AND r.status='pending_approval' AND v_date>w.period_start+2 THEN 'expired_unapproved' ELSE r.status END,
  'auto_expired',r.auto_expired,
  'can_review',coalesce(w.request_id IS NOT NULL AND r.status='pending_approval' AND v_date BETWEEN w.period_start AND w.period_start+2,false)) ORDER BY r.id),'[]'::jsonb)
 INTO v_count,v_items FROM public.advance_requests r LEFT JOIN public.weekly_bale_requests w ON w.request_id=r.id
 WHERE r.id=ANY(p_ids) AND (v_founder OR (v_role='supervisor' AND r.submitted_by=auth.uid()));
 IF v_count<>cardinality(p_ids) THEN RAISE EXCEPTION 'One or more requests are unavailable' USING ERRCODE='P0002'; END IF;
 RETURN jsonb_build_object('as_of',v_now,'items',v_items);
END $$;
REVOKE ALL ON FUNCTION public.weekly_bale_status_batch(uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.weekly_bale_status_batch(uuid[]) TO authenticated;
DO $$ BEGIN
 IF has_function_privilege('anon','public.weekly_bale_status_batch(uuid[])','EXECUTE') OR has_function_privilege('service_role','public.weekly_bale_status_batch(uuid[])','EXECUTE') THEN
  RAISE EXCEPTION 'Unexpected inherited weekly Bale status privilege'; END IF;
END $$;
