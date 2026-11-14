'use client';
import { categoryPreviewEnabled } from '@/lib/workforce/categoryCatalog';
import { WorkerCategoryManager } from './WorkerCategoryManager';

/** Display gate only. The draft RPC must independently authorize every call. */
export function WorkerCategoryFoundation({userId,isFounder,assurance,authLoading}:{userId:string|undefined;isFounder:boolean;assurance:string;authLoading:boolean}) {
 if(!categoryPreviewEnabled()||!isFounder||assurance!=='ready'||authLoading||!userId)return null;
 return <WorkerCategoryManager key={userId} userId={userId}/>;
}
