// CI fixture only. Never use with real data or a hosted database.
import {Client} from 'pg';
const source='postgresql://postgres@127.0.0.1:5433/asinta_test_pr103';
const target='postgresql://postgres@127.0.0.1:5433/asinta_test_partial_restore';
const mode=process.argv[2];
if(!['prepare-source','prepare-target','verify'].includes(mode))throw new Error('Choose a synthetic fixture operation');
const connect=async(url)=>{const c=new Client({connectionString:url});await c.connect();return c;};
if(mode==='prepare-source'){
 const c=await connect(source);try{
  await c.query(`CREATE TABLE app_private.synthetic_backup_fixture(id integer primary key,value text NOT NULL); INSERT INTO app_private.synthetic_backup_fixture VALUES(1,'private fixture');`);
 }finally{await c.end();}
}else if(mode==='prepare-target'){
 const admin=await connect(source);try{await admin.query('CREATE DATABASE asinta_test_partial_restore');}finally{await admin.end();}
 const c=await connect(target);try{
  // Minimal stand-ins for external objects. These are NOT Supabase Auth or Storage.
  await c.query(`CREATE SCHEMA auth;CREATE SCHEMA storage;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
   CREATE TABLE storage.objects(bucket_id text,name text);`);
 }finally{await c.end();}
}else{
 const a=await connect(source),b=await connect(target);
 try{
  const sql=`SELECT (SELECT md5(coalesce(string_agg(row_to_json(p)::text,',' ORDER BY id),'')) FROM public.payroll p) AS payroll,
   (SELECT md5(coalesce(string_agg(row_to_json(a)::text,',' ORDER BY id),'')) FROM public.attendance a) AS attendance,
   (SELECT md5(coalesce(string_agg(row_to_json(w)::text,',' ORDER BY id),'')) FROM public.workers w) AS workers,
   (SELECT md5(coalesce(string_agg(row_to_json(x)::text,',' ORDER BY id),'')) FROM app_private.synthetic_backup_fixture x) AS private_rows,
   app_private.normal_leave_notice_allowed('2026-11-05','2026-11-03 15:59:59+00') AS private_function`;
  const sourceResult=(await a.query(sql)).rows[0],targetResult=(await b.query(sql)).rows[0];
  if(JSON.stringify(sourceResult)!==JSON.stringify(targetResult))throw new Error('Synthetic restore differs from source fixture');
  console.log('Selected synthetic public/app_private rows and function matched. Auth, Storage, ownership, grants and hosted behavior were not tested.');
 }finally{await Promise.all([a.end(),b.end()]);}
}
