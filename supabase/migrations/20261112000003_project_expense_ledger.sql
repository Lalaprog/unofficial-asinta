-- Founder-only recorded-expense totals and keyset-paged ledger. Both functions
-- run as the caller, so existing RLS and MFA restrictions remain in effect.
-- These are read-only views of expenses, NOT a new accounting ledger.
CREATE OR REPLACE FUNCTION public.project_expense_totals(p_project_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
  IF p_project_ids IS NULL OR cardinality(p_project_ids)>2000 OR array_position(p_project_ids,NULL) IS NOT NULL
    OR (SELECT count(DISTINCT x) FROM unnest(p_project_ids) x) <> cardinality(p_project_ids) THEN
    RAISE EXCEPTION 'Invalid project list' USING ERRCODE='22023';
  END IF;
  IF (SELECT count(*) FROM public.projects WHERE id=ANY(p_project_ids)) <> cardinality(p_project_ids) THEN
    RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('project_id', p.id, 'expense_count', coalesce(e.n,0),
    'total', coalesce(e.total,0)::text) ORDER BY p.id),'[]'::jsonb) INTO v_result
  FROM public.projects p LEFT JOIN (
    SELECT project_id, count(*) AS n, sum(amount) AS total FROM public.expenses
    WHERE project_id=ANY(p_project_ids) GROUP BY project_id
  ) e ON e.project_id=p.id WHERE p.id=ANY(p_project_ids);
  IF octet_length(v_result::text) > 1048576 THEN RAISE EXCEPTION 'Project totals too large' USING ERRCODE='54000'; END IF;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.project_expense_page(
  p_project_id uuid, p_cursor_date date DEFAULT NULL, p_cursor_id uuid DEFAULT NULL, p_limit integer DEFAULT 25
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
  IF p_project_id IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR (p_cursor_date IS NULL) <> (p_cursor_id IS NULL) THEN
    RAISE EXCEPTION 'Invalid project or cursor' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project_id) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
  WITH rows AS MATERIALIZED (
    SELECT e.id,e.project_id,e.description,e.category,e.amount,e.expense_date,e.notes
    FROM public.expenses e WHERE e.project_id=p_project_id
      AND (p_cursor_date IS NULL OR (e.expense_date,e.id) < (p_cursor_date,p_cursor_id))
    ORDER BY e.expense_date DESC,e.id DESC LIMIT p_limit+1
  ), page AS (SELECT * FROM rows ORDER BY expense_date DESC,id DESC LIMIT p_limit)
  SELECT jsonb_build_object('has_more',(SELECT count(*)>p_limit FROM rows),
    'items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'project_id',p.project_id,
      'description',p.description,'category',p.category,'amount',p.amount::text,
      'expense_date',p.expense_date,'notes',p.notes) ORDER BY p.expense_date DESC,p.id DESC) FROM page p),'[]'::jsonb)) INTO v_result;
  IF octet_length(v_result::text)>1048576 THEN RAISE EXCEPTION 'Expense page too large to display safely' USING ERRCODE='54000'; END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.project_expense_totals(uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.project_expense_page(uuid,date,uuid,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.project_expense_totals(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.project_expense_page(uuid,date,uuid,integer) TO authenticated;
CREATE INDEX IF NOT EXISTS expense_project_history_order_idx ON public.expenses(project_id,expense_date DESC,id DESC);
