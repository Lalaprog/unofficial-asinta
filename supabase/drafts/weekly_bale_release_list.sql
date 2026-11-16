-- DRAFT ONLY. Requires the exact weekly Bale schedule + expiry drafts.
-- Authorized current-site Supervisors can see approved/issued requests from
-- their sites, not all requests or sites. This does not install a scheduler.
CREATE FUNCTION public.weekly_bale_release_list(p_start date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count integer; v_items jsonb; v_founder boolean; v_role text;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Authorized access required' USING ERRCODE='42501'; END IF;
 v_founder:=coalesce(public.is_founder(),false);v_role:=public.current_user_role();
 IF NOT v_founder AND v_role IS DISTINCT FROM 'supervisor' THEN RAISE EXCEPTION 'Authorized access required' USING ERRCODE='42501'; END IF;
 IF p_start IS NULL OR p_start<DATE '1900-01-01' OR p_start>DATE '9998-12-24' OR extract(dow FROM p_start)<>0 THEN RAISE EXCEPTION 'Choose a Sunday' USING ERRCODE='22023'; END IF;
 -- Use a single snapshot and reject rather than silently truncate at the cap.
 SELECT count(*)::integer,coalesce(jsonb_agg(jsonb_build_object('request_id',q.id,'worker_id',q.worker_id,'worker_name',q.worker_name,
  'project_id',q.project_id,'project_name',q.project_name,'amount',q.requested_amount::numeric(10,2)::text,'status',q.status,
  'release_date',q.release_date,'issued_advance_id',q.issued_advance_id,'assignment_review_required',q.assignment_review_required) ORDER BY q.project_id,q.worker_name,q.id),'[]'::jsonb)
 INTO v_count,v_items FROM (
  SELECT r.id,r.worker_id,worker.name worker_name,r.project_id,project.name project_name,r.requested_amount,r.status,
   w.period_start+3 release_date,r.issued_advance_id,
   (worker.active IS NOT TRUE OR EXISTS(SELECT 1 FROM public.users u WHERE u.id=r.worker_id AND u.role='supervisor') OR NOT EXISTS(SELECT 1 FROM public.project_worker_assignments a WHERE a.worker_id=r.worker_id AND a.project_id=r.project_id AND a.active IS TRUE)
    OR EXISTS(SELECT 1 FROM public.project_worker_assignments a WHERE a.worker_id=r.worker_id AND a.project_id<>r.project_id AND a.active IS TRUE)) AS assignment_review_required
  FROM public.weekly_bale_requests w JOIN public.advance_requests r ON r.id=w.request_id
  JOIN public.workers worker ON worker.id=r.worker_id JOIN public.projects project ON project.id=r.project_id
  WHERE w.period_start=p_start AND r.status IN ('approved_pending_payment','issued')
   AND (v_founder OR (v_role='supervisor' AND coalesce(public.is_supervisor_assigned(r.project_id),false)))
  ORDER BY r.id LIMIT 501
 ) q;
 IF v_count>500 THEN RAISE EXCEPTION 'Too many weekly requests; use a reviewed paginated interface' USING ERRCODE='54000'; END IF;
 RETURN jsonb_build_object('start',p_start,'end',p_start+6,'items',v_items);
END $$;
REVOKE ALL ON FUNCTION public.weekly_bale_release_list(date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.weekly_bale_release_list(date) TO authenticated;
DO $$ BEGIN
 IF has_function_privilege('anon','public.weekly_bale_release_list(date)','EXECUTE') OR has_function_privilege('service_role','public.weekly_bale_release_list(date)','EXECUTE') THEN
  RAISE EXCEPTION 'Unexpected inherited weekly release-list privilege'; END IF;
END $$;
