'use client';
import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {useAuth} from '@/lib/auth/authContext';
import {createClient} from '@/lib/supabase/client';
import {parsePaidAttendanceReview,type PaidAttendanceStatus} from '@/lib/payroll/paidAttendanceReview';
import type {PaidReviewVoucher} from '@/lib/payroll/paidReview';

/** Point-in-time signal only; never changes a voucher or calculates an adjustment. */
export function PaidAttendanceReview({voucher}:{voucher:PaidReviewVoucher}){
 const {user,isFounder,assurance}=useAuth();
 const key=JSON.stringify([user?.id,isFounder,assurance,voucher.id,voucher.worker_id,voucher.period_start,voucher.period_end]);
 const [state,setState]=useState<{key:string;loading:boolean;result:PaidAttendanceStatus|null;error:string}>({key:'',loading:false,result:null,error:''});
 const seq=useRef(0),busy=useRef(false),current=useRef(key);current.current=key;
 useEffect(()=>{const token=seq;token.current++;busy.current=false;setState({key,loading:false,result:null,error:''});return()=>{token.current++;};},[key]);
 const shown=state.key===key?state:{key,loading:false,result:null,error:''};
 async function load(){
  if(!user?.id||!isFounder||assurance!=='ready'||busy.current)return;
  const token=++seq.current;busy.current=true;setState({key,loading:true,result:null,error:''});
  try{const {data,error}=await createClient().rpc('weekly_paid_attendance_change_review',{p_id:voucher.id});if(error)throw new Error(error.message);const result=parsePaidAttendanceReview(data,voucher);if(token===seq.current&&current.current===key)setState({key,loading:false,result,error:''});}
  catch(e){if(token===seq.current&&current.current===key)setState({key,loading:false,result:null,error:e instanceof Error?e.message:'Comparison unavailable'});}
  finally{if(token===seq.current&&current.current===key)busy.current=false;}
 }
 return <div className="mt-3 space-y-2 border-t border-surface-border pt-3">
  <p>Compare the saved weekly attendance snapshot with current attendance and regular/OT details. This does not check rates, allowances, Bale, external payments or project costs. Changes after this check are not shown until refreshed.</p>
  <Button type="button" size="sm" variant="secondary" disabled={!user?.id||!isFounder||assurance!=='ready'||shown.loading} isLoading={shown.loading} onClick={load}>{shown.result?'Recheck attendance':'Check attendance changes'}</Button>
  {shown.error&&<p role="alert">Attendance comparison unavailable: {shown.error}. Do not assume the records match.</p>}
  {shown.result==='changed'&&<p role="status" className="font-semibold text-status-warning">Attendance or time details differ from the saved paid snapshot. Investigate the original period and review a separate correction if needed; do not change the paid voucher or carry a difference into a later week.</p>}
  {shown.result==='unchanged'&&<p role="status">The selected attendance and time details matched at this check. This does not prove the payment or other payroll inputs are correct.</p>}
  {shown.result==='unavailable'&&<p role="status" className="font-semibold text-status-warning">No saved weekly attendance snapshot is available for this voucher. Review original records; this is not a clean result.</p>}
 </div>;
}
