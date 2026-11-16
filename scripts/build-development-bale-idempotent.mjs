import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';

if(process.argv.length!==2) throw Error('No arguments accepted');
const source='supabase/drafts/weekly_bale_idempotent_submission.sql';
const candidate=readFileSync(source,'utf8');
const sha=createHash('sha256').update(candidate).digest('hex');
if(sha!=='e8c9c55c23cd259f2166196c4a94eab17cf3824d6d6d873728a494f1430541d9') throw Error('Bale candidate changed; re-review before building');
const prefix=`-- DEVELOPMENT ONLY: additive Bale exact-retry RPC, not a release authorization.
-- Source ${source} SHA-256 ${sha}
-- Verify target independently. Requires a single managed transaction; preserve legacy INSERT.
-- This does not prevent different-ID duplicates or prove hosted Auth/client compatibility.
DO $manual_hold$ BEGIN IF current_setting('app.bale_idempotent_development_reviewed',true) IS DISTINCT FROM 'yes' THEN RAISE EXCEPTION 'Development Bale idempotency held pending review'; END IF; END $manual_hold$;
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
LOCK TABLE public.advance_requests,public.weekly_bale_requests IN SHARE ROW EXCLUSIVE MODE;
DO $development_preflight$
DECLARE r record; f oid;
BEGIN
 IF current_database()<>'postgres' OR to_regprocedure('public.submit_weekly_bale_request(uuid,uuid,uuid,numeric,date)') IS NOT NULL THEN RAISE EXCEPTION 'Unexpected database or existing Bale RPC'; END IF;
 FOR r IN SELECT * FROM (VALUES
  ('public.session_assurance_satisfied()','d4c6a53f7792703119ac26443213db4f4cf695d0b390f008a5926f3b32569850',true),
  ('public.current_user_role()','8a94e17d4fe98a1746d061b4c1532addf59821d3a504d49493a8fe1ac4d83494',true),
  ('public.is_supervisor_assigned(uuid)','84ddf3b3871773152d757926f35612f49741d19bc44d89729c4c41a247a52340',true),
  ('public.guard_advance_request_site()','4b0f66bb051058711073a157d4ac38818c94b22eed24ee0ad874e60a9823cffa',true),
  ('public.guard_weekly_bale_submission()','f7aab87753ffe1583821fdc6fe808b7ea9ff47fd25d475b793a08b4e0d4f2e08',true),
  ('public.register_weekly_bale_submission()','b3de90fa6a8893c3477776912e0f1a78931c80bff7c68226501067c788f7fdfe',true),
  ('public.audit_advance_request_change()','542942a71bef8505652a708ae6148ba9444c4cce6fb8db19e26b1ec209cb52a2',true),
  ('public.notify_advance_request_event()','7d191ae71b3c36cd0d75016d7f81d2e4f0c90233698a64771f6a959b80b257e8',true),
  ('public.weekly_bale_clock()','066a9baaa540fab4af1ce7f58f42f900e4f22817ae9091a847c9343d5741728c',false),
  ('public.weekly_bale_week(timestamp with time zone)','9682a76f422e62fd8fee58ca96bd4329621d24e596a8cb7f2b177b1a93e9c22d',false)
 ) AS expected(signature,digest,definer) LOOP
  f:=to_regprocedure(r.signature);
  IF f IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=f AND p.prokind='f' AND p.prosecdef=r.definer AND pg_get_userbyid(p.proowner)='postgres') OR encode(sha256(convert_to(pg_get_functiondef(f),'UTF8')),'hex') IS DISTINCT FROM r.digest THEN RAISE EXCEPTION 'Bale dependency changed: %',r.signature; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid='public.advance_requests'::regclass AND NOT tgisinternal)<>6 THEN RAISE EXCEPTION 'Request trigger set changed'; END IF;
 FOR r IN SELECT * FROM (VALUES
  ('audit_advance_request_change','28a21110831a4504b5ce7008bcd5a3fe22b759b3374581cd7437b30ed53d5073'),
  ('guard_advance_request_site','19df7f3255c526093c4936cd5aa33102c91f9c27ab68d05d10bfd240a442558f'),
  ('guard_weekly_bale_submission','5742deccdca64ed6fce27a5def1748386981e1c0c9472a79d88407a163979ffd'),
  ('guard_weekly_bale_transition','12b61a71b0479e5812080508232d2ed4323431f5f0ace4bda5e9e6756daa9a69'),
  ('notify_advance_request_event','680101dc5448c233deb4deb541cdf1e91893409e6c63a158aa36c0b2a188414c'),
  ('register_weekly_bale_submission','3d15f098b0766cad0e1eea18acaa12f3b6bc78336645341c67f35d8820e83ad2')
 ) AS expected(name,digest) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid='public.advance_requests'::regclass AND t.tgname=r.name AND NOT t.tgisinternal AND t.tgenabled='O' AND encode(sha256(convert_to(pg_get_triggerdef(t.oid),'UTF8')),'hex')=r.digest) THEN RAISE EXCEPTION 'Request trigger changed: %',r.name; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN ('public.advance_requests'::regclass,'public.weekly_bale_requests'::regclass) AND (pg_get_userbyid(c.relowner)<>'postgres' OR NOT c.relrowsecurity OR c.relforcerowsecurity)) THEN RAISE EXCEPTION 'Bale table ownership or RLS changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='advance_requests' AND column_name='status' AND column_default=$d$'pending_approval'::text$d$) OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='advance_requests' AND column_name IN ('approved_by','approved_at','rejected_by','rejected_at','issued_by','issued_at','issued_advance_id') AND column_default IS NOT NULL) THEN RAISE EXCEPTION 'Request defaults changed'; END IF;
 IF pg_has_role('anon','authenticated','MEMBER') OR pg_has_role('service_role','authenticated','MEMBER') OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='postgres' AND rolbypassrls) THEN RAISE EXCEPTION 'Role inheritance or definer behavior changed'; END IF;
END $development_preflight$;
SET LOCAL app.weekly_bale_idempotent_submission_reviewed='yes';
`;
const suffix=`\nDO $development_postflight$
DECLARE f oid:=to_regprocedure('public.submit_weekly_bale_request(uuid,uuid,uuid,numeric,date)');
BEGIN
 IF f IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=f AND prokind='f' AND prosecdef AND pg_get_userbyid(proowner)='postgres' AND proconfig @> ARRAY['search_path=""']) OR has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('service_role',f,'EXECUTE') OR NOT has_function_privilege('authenticated',f,'EXECUTE') THEN RAISE EXCEPTION 'Bale RPC postflight failed'; END IF;
END $development_postflight$;
`;
mkdirSync('supabase/release',{recursive:true});
writeFileSync('supabase/release/development-bale-idempotent.sql',prefix+candidate+suffix);
