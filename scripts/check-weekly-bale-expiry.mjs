#!/usr/bin/env node
// External read-only probe. Not a scheduler or alert service: an independently
// operated scheduler must run it and alert on non-zero exit and missing runs.
// BALE_MONITOR_DATABASE_URL is a secret; never log it or database errors.
import pg from 'pg';
import {pathToFileURL} from 'node:url';

export function connectionConfig(env) {
 const raw=env.BALE_MONITOR_DATABASE_URL, expected=env.BALE_MONITOR_DATABASE_ROLE;
 if(!raw || !expected || !/^[a-z_][a-z0-9_]{0,62}$/.test(expected)) throw Error('Monitor configuration missing');
 const url=new URL(raw);
 if(!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.searchParams.getAll('sslmode').length!==1 || url.searchParams.get('sslmode')!=='verify-full') throw Error('Verified TLS is required');
 // Do not allow connection-string SSL options to override the explicit TLS policy.
 for(const key of url.searchParams.keys()) if(key.toLowerCase().startsWith('ssl') && key!=='sslmode') throw Error('Unsupported TLS option');
 url.searchParams.delete('sslmode');
 return {expected, options:{connectionString:url.toString(),ssl:{rejectUnauthorized:true},connectionTimeoutMillis:5000,query_timeout:5000,statement_timeout:3000}};
}

// Use a dedicated login with no access to sensitive tables, no elevated roles,
// and no ability to run the expiry worker or replace its monitor function.
// These checks reduce misconfiguration risk; they do not audit every privilege.
export const roleCheck=`SELECT current_user::text AS role_name, session_user::text AS session_role,
 r.rolsuper AS superuser,r.rolbypassrls AS bypass_rls,r.rolcreaterole AS create_role,
 r.rolcreatedb AS create_db,r.rolreplication AS replication,
 EXISTS(SELECT 1 FROM pg_catalog.pg_roles x WHERE (x.rolsuper OR x.rolbypassrls OR x.rolcreaterole OR x.rolcreatedb OR x.rolreplication OR x.rolname IN ('anon','authenticated','service_role'))
  AND pg_catalog.pg_has_role(current_user,x.oid,'MEMBER')) AS elevated_membership,
 pg_catalog.has_schema_privilege(current_user,'public','CREATE') AS schema_create,
 pg_catalog.pg_has_role(current_user,p.proowner,'MEMBER') AS owns_monitor,
 pg_catalog.has_function_privilege(current_user,'public.run_weekly_bale_expiry_job()','EXECUTE') AS can_run_job,
 EXISTS(SELECT 1 FROM unnest(ARRAY['public.payroll','public.advances','public.advance_requests','public.weekly_bale_requests','public.weekly_bale_expiry_health']) n(name)
   WHERE pg_catalog.has_table_privilege(current_user,n.name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=pg_catalog.to_regclass(n.name) AND a.attnum>0 AND NOT a.attisdropped
       AND pg_catalog.has_column_privilege(current_user,a.attrelid,a.attname,'SELECT,INSERT,UPDATE,REFERENCES'))) AS table_access
 FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_proc p
 WHERE r.rolname=current_user AND p.oid=pg_catalog.to_regprocedure('public.weekly_bale_external_monitor_healthy()')`;

export async function check(env,createClient=(options)=>new pg.Client(options)) {
 let client;
 try {
  const {expected,options}=connectionConfig(env);
  client=createClient(options);await client.connect();
  const role=(await client.query(roleCheck)).rows;
  if(role.length!==1 || role[0].role_name!==expected || role[0].session_role!==expected ||
     ['superuser','bypass_rls','create_role','create_db','replication','elevated_membership','schema_create','owns_monitor','can_run_job','table_access'].some(key=>role[0][key]!==false)) return false;
  const rows=(await client.query('SELECT public.weekly_bale_external_monitor_healthy() AS healthy')).rows;
  return rows.length===1 && rows[0].healthy===true;
 } catch { return false; }
 finally { if(client) try { await client.end(); } catch { /* Never print connection errors or secrets. */ } }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 const healthy=await check(process.env);
 console.log(healthy?'Weekly Bale expiry monitor: healthy observation.':'Weekly Bale expiry monitor: UNHEALTHY or unavailable. Investigate; do not assume the job ran.');
 process.exitCode=healthy?0:1;
}
