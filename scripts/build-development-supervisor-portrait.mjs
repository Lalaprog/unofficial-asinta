#!/usr/bin/env node
// Only the reviewed empty-portrait DEVELOPMENT target; one managed transaction.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
if(process.argv.length!==2)throw Error('No arguments expected');
const source=readFileSync('supabase/drafts/supervisor_profile_photo.sql','utf8');
if(/^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\s*;/im.test(source)||/^\s*\\/m.test(source))throw Error('Unexpected transaction control');
const artifact=`-- Development-only Supervisor photo artifact. Use in ONE managed transaction.
-- Source SHA256 ${createHash('sha256').update(source).digest('hex')}
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
LOCK TABLE public.users, public.audit_log IN SHARE ROW EXCLUSIVE MODE;
DO $preflight$ BEGIN
 IF current_database()<>'postgres' THEN RAISE EXCEPTION 'Unexpected database';END IF;
 IF (SELECT count(*) FROM public.users WHERE role='founder')<>1 OR (SELECT count(*) FROM public.users WHERE role='supervisor')<>1 THEN RAISE EXCEPTION 'Development profile state changed';END IF;
 IF NOT coalesce((SELECT relrowsecurity FROM pg_class WHERE oid='public.users'::regclass),false) OR
  md5(pg_get_functiondef('public.is_founder()'::regprocedure))<>'4ed57b18b9d05216cfa70359ca2553fb' OR
  md5(pg_get_functiondef('public.session_assurance_satisfied()'::regprocedure))<>'390d4f2b3755c6a961ac1f1892d3e801' OR
  md5(pg_get_functiondef('auth.uid()'::regprocedure))<>'ea3b41bf29e2ad573067939329aa088e' THEN RAISE EXCEPTION 'Account authorization drift';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.users'::regclass AND tgname='lock_user_mutations' AND tgenabled='O') OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.users'::regclass AND tgname='check_founder_after_update' AND tgenabled='O') OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.users'::regclass AND tgname='check_founder_after_delete' AND tgenabled='O') THEN RAISE EXCEPTION 'Account mutation guards changed';END IF;
END $preflight$;
${source}
DO $postflight$ BEGIN
 IF EXISTS(SELECT 1 FROM public.supervisor_profile_photos) OR NOT coalesce((SELECT relrowsecurity FROM pg_class WHERE oid='public.supervisor_profile_photos'::regclass),false) THEN RAISE EXCEPTION 'Portrait postflight failed';END IF;
END $postflight$;
`;
writeFileSync('supabase/release/development-supervisor-portrait.sql',artifact);
