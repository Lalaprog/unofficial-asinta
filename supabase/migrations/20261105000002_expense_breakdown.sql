-- Optional receipt breakdown, stored with the expense in the same row. The
-- authoritative expense amount remains expenses.amount; items are descriptive
-- and are never summed into the ledger a second time. Existing rows remain
-- unchanged. No policies, grants or storage buckets are modified.
CREATE OR REPLACE FUNCTION public.expense_items_valid(items jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN items IS NULL THEN true
    WHEN pg_catalog.jsonb_typeof(items) IS DISTINCT FROM 'array' THEN false
    WHEN pg_catalog.jsonb_array_length(items) > 100 THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(items) AS entry(item)
      WHERE pg_catalog.jsonb_typeof(item) IS DISTINCT FROM 'object'
        OR pg_catalog.jsonb_typeof(item->'name') IS DISTINCT FROM 'string'
        OR pg_catalog.length(pg_catalog.btrim(item->>'name')) NOT BETWEEN 1 AND 160
        OR CASE WHEN item->'quantity' IS NULL OR item->'quantity' = 'null'::jsonb THEN false
          ELSE pg_catalog.jsonb_typeof(item->'quantity') IS DISTINCT FROM 'string'
            OR pg_catalog.length(item->>'quantity') > 60 END
        OR CASE WHEN item->'amount' IS NULL OR item->'amount' = 'null'::jsonb THEN false
          WHEN pg_catalog.jsonb_typeof(item->'amount') IS DISTINCT FROM 'number' THEN true
          ELSE (item->>'amount')::numeric < 0 OR (item->>'amount')::numeric > 9999999999.99
            OR (item->>'amount')::numeric <> pg_catalog.round((item->>'amount')::numeric, 2) END
    )
  END;
$$;

ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS details text;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS line_items jsonb;
ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS expense_line_items_valid;
ALTER TABLE public.expenses ADD CONSTRAINT expense_line_items_valid CHECK (public.expense_items_valid(line_items));
ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS expense_details_length;
ALTER TABLE public.expenses ADD CONSTRAINT expense_details_length CHECK (details IS NULL OR pg_catalog.length(details) <= 5000);

-- A monotonic revision lets the new edit form fail closed instead of silently
-- overwriting an expense changed in another session, including old-client edits.
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION public.bump_expense_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bump_expense_revision ON public.expenses;
CREATE TRIGGER bump_expense_revision BEFORE UPDATE ON public.expenses
FOR EACH ROW EXECUTE FUNCTION public.bump_expense_revision();
