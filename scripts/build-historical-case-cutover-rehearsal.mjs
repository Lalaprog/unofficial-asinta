#!/usr/bin/env node
// Synthetic rehearsal only, NOT a shared-development or production installer.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const check=process.argv.length===3&&process.argv[2]==='--check';
if(process.argv.length!==2&&!check)throw Error('Only --check is accepted');
const sources=[
 ['supabase/drafts/historical_attribution_case_binding.sql','7ff4dd7165efeb165a9b491d648a55d116b46eefef1fa0a81baec32b368f7a81'],
 ['supabase/drafts/historical_attribution_write_barrier.sql','44907d0e8b415027ec0caf711f00db1fb09c4e4d898b0eee92ff74cdf46e0c52'],
];
const content=sources.map(([path,sha])=>{
 const sql=readFileSync(path,'utf8');if(createHash('sha256').update(sql).digest('hex')!==sha)throw Error(`Candidate changed; review and re-pin: ${path}`);
 if(/^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\s*;/im.test(sql)||/^\s*\\/m.test(sql))throw Error(`Unexpected transaction control: ${path}`);
 return sql;
});
const prefix=`-- HELD: ISOLATED SYNTHETIC REHEARSAL ONLY. NOT AN INSTALLER.
-- This must be executed as ONE transaction; all steps roll back together.
-- Source pins: ${sources.map(([p,h])=>`${p}=${h}`).join(' ')}
-- Existing unbound rows halt the exercise; nothing is silently upgraded.
-- Owners, privileged/dynamic writers, deployment, recovery, real Auth and
-- full dependency/lock compatibility remain unverified. Do not run on shared DBs.
DO $hold$ BEGIN IF current_setting('app.historical_case_atomic_rehearsal',true) IS DISTINCT FROM 'synthetic-only' THEN RAISE EXCEPTION 'Held historical atomic cutover: synthetic rehearsal only'; END IF; END $hold$;
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
-- Wait for old insert transactions; a later old insert hits the barrier.
LOCK TABLE public.historical_worker_attributions IN ACCESS EXCLUSIVE MODE;
DO $preflight$ BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Read committed required'; END IF;
 IF EXISTS(SELECT 1 FROM public.historical_worker_attributions) OR EXISTS(SELECT 1 FROM public.historical_worker_attribution_sites) THEN RAISE EXCEPTION 'Existing unbound historical attribution requires separate review'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN ('public.historical_worker_attributions'::regclass,'public.historical_worker_attribution_sites'::regclass) AND (pg_get_userbyid(c.relowner)<>'postgres' OR NOT c.relrowsecurity OR c.relforcerowsecurity)) THEN RAISE EXCEPTION 'Attribution table owner or RLS changed'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r CROSS JOIN unnest(ARRAY['public.historical_worker_attributions','public.historical_worker_attribution_sites']) t WHERE has_table_privilege(r,t,'INSERT,UPDATE,DELETE,TRUNCATE') OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=to_regclass(t) AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r,a.attrelid,a.attname,'INSERT,UPDATE'))) THEN RAISE EXCEPTION 'Attribution direct write privilege exists'; END IF;
END $preflight$;
SET LOCAL app.historical_case_binding_candidate='synthetic-only';
`;
const middle="\nSET LOCAL app.historical_case_barrier_candidate='synthetic-only';\n";
const suffix=`\nDO $postflight$ BEGIN
 IF EXISTS(SELECT 1 FROM public.historical_worker_attributions) OR EXISTS(SELECT 1 FROM public.historical_attribution_case_bindings) OR EXISTS(SELECT 1 FROM public.historical_attribution_write_permits) THEN RAISE EXCEPTION 'Unexpected attribution evidence'; END IF;
 IF has_function_privilege('authenticated','public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean)','EXECUTE') OR NOT has_function_privilege('authenticated','public.record_historical_attribution_with_cases(uuid,uuid,jsonb,jsonb,text,boolean,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Writer cutover ACL failed'; END IF;
END $postflight$;
`;
const destination='supabase/drafts/historical_attribution_atomic_rehearsal.sql',artifact=prefix+content[0]+middle+content[1]+suffix;
if(check){if(readFileSync(destination,'utf8')!==artifact)throw Error('Generated rehearsal differs');}
else writeFileSync(destination,artifact);
