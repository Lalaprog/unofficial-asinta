import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const [founder,sup,other,worker,pay,request,second,third]=[1,2,3,4,5,6,7,8].map(id);

describe('Supervisor leave requests',()=>{
 it('enforces Manila notice, scoped review, replay and paid-history warnings without changing finance',async()=>{
  const db=new PGlite();try{
   await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
    CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
    CREATE TABLE public.users(id uuid primary key,name text,role text); CREATE TABLE public.workers(id uuid primary key,name text);
    CREATE TABLE public.payroll(id uuid primary key,worker_id uuid,period_start date,period_end date,status text);
    CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT public.session_assurance_satisfied() AND EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
    INSERT INTO public.users VALUES ('${founder}','Founder','founder'),('${sup}','Supervisor A','supervisor'),('${other}','Supervisor B','supervisor');
    INSERT INTO public.workers VALUES ('${worker}','Supervisor A');
    INSERT INTO public.payroll VALUES ('${pay}','${worker}','2020-01-01','2020-01-15','paid');
    GRANT USAGE ON SCHEMA public,auth TO authenticated,anon;`);
   await db.exec(readFileSync('supabase/migrations/20261113000005_supervisor_leave.sql','utf8'));
   const boundary=await db.query<{before:boolean;after:boolean}>(`SELECT app_private.normal_leave_notice_allowed('2026-11-05','2026-11-03 15:59:59+00') AS before, app_private.normal_leave_notice_allowed('2026-11-05','2026-11-03 16:00:00+00') AS after`);
   expect(boundary.rows[0]).toEqual({before:true,after:false});
   await db.exec(`SET test.uid='${sup}'; SET test.assurance='yes'; SET ROLE authenticated`);
   const submit=(key:string,start:string,end:string,kind:string,reason='')=>db.query<{data:{id:string;status:string;replayed:boolean}}>('SELECT public.submit_supervisor_leave($1,$2,$3,$4,$5) data',[key,start,end,kind,reason]);
   const review=(key:string,decision:string)=>db.query<{data:{id:string;status:string;replayed:boolean}}>('SELECT public.review_supervisor_leave($1,$2) data',[key,decision]);
   const today=(await db.query<{today:string}>("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date::text today")).rows[0].today;
   const add=(n:number)=>new Date(Date.parse(today+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
   await expect(submit(request,add(1),add(1),'normal')).rejects.toThrow(/two calendar days/);
   expect((await submit(request,add(2),add(3),'normal','Personal')).rows[0].data).toEqual({id:request,status:'pending',replayed:false});
   expect((await submit(request,add(2),add(3),'normal','Personal')).rows[0].data.replayed).toBe(true);
   await expect(submit(request,add(2),add(3),'normal','Changed')).rejects.toThrow(/different leave/);
   await expect(submit(second,add(3),add(4),'emergency')).rejects.toThrow(/overlaps/);
   await expect(review(request,'approved')).rejects.toThrow(/Founder/);
   await expect(db.query('SELECT * FROM public.supervisor_leave_requests')).rejects.toThrow(/permission denied/);
   expect((await submit(second,'2020-01-07','2020-01-08','emergency','Urgent')).rows[0].data.status).toBe('pending');
   let list=(await db.query<{data:{total:number;items:Array<Record<string,unknown>>}}>('SELECT public.supervisor_leave_list() data')).rows[0].data;
   expect(list.total).toBe(2);expect(list.items.every(x=>x.possible_paid_overlap===null && x.identity_needs_review===null)).toBe(true);
   await db.exec(`SET test.uid='${other}'`);
   list=(await db.query<{data:{total:number;items:Array<Record<string,unknown>>}}>('SELECT public.supervisor_leave_list() data')).rows[0].data;expect(list.total).toBe(0);
   await db.exec(`SET test.uid='${founder}'`);
   list=(await db.query<{data:{total:number;items:Array<Record<string,unknown>>}}>('SELECT public.supervisor_leave_list() data')).rows[0].data;
   expect(list.items.find(x=>x.id===second)).toMatchObject({possible_paid_overlap:true,identity_needs_review:true,status:'pending'});
   expect((await review(second,'approved')).rows[0].data).toEqual({id:second,status:'approved',replayed:false});
   expect((await review(second,'approved')).rows[0].data.replayed).toBe(true);
   await expect(review(second,'rejected')).rejects.toThrow(/already decided/);
   expect((await review(request,'rejected')).rows[0].data.status).toBe('rejected');
   await db.exec(`SET test.uid='${sup}'`);
   expect((await submit(request,add(2),add(3),'normal','Personal')).rows[0].data.status).toBe('rejected');
   expect((await submit(third,add(2),add(3),'emergency')).rows[0].data.status).toBe('pending');
   await db.exec(`SET test.assurance='no'`);await expect(submit(id(9),add(10),add(10),'normal')).rejects.toThrow(/Supervisor access/);await expect(db.query('SELECT public.supervisor_leave_list()')).rejects.toThrow(/Leave access/);
   await db.exec('RESET ROLE');expect((await db.query<{status:string}>('SELECT status FROM public.payroll')).rows[0].status).toBe('paid');
   await db.exec(`INSERT INTO public.supervisor_leave_requests(id,supervisor_id,start_date,end_date,kind,reason,status,submitted_at,reviewed_by,reviewed_at) SELECT gen_random_uuid(),'${sup}','2020-01-01','2020-01-01','emergency','','rejected',clock_timestamp(),'${founder}',clock_timestamp() FROM generate_series(1,105); SET test.assurance='yes'; SET ROLE authenticated;`);
   const first=(await db.query<{data:{total:number;offset:number;items:unknown[]}}>('SELECT public.supervisor_leave_list(0) data')).rows[0].data;
   const next=(await db.query<{data:{total:number;offset:number;items:unknown[]}}>('SELECT public.supervisor_leave_list(100) data')).rows[0].data;
   expect([first.total,first.offset,first.items.length,next.offset,next.items.length]).toEqual([108,0,100,100,8]);
   await expect(db.query('SELECT public.supervisor_leave_list(-1)')).rejects.toThrow(/Invalid leave list offset/);
  }finally{await db.close();}
 },30000);
});
