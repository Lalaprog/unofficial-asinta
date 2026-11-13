export type WorkerMoveAttempt = {requestId:string;actorId:string;workerId:string;fromProject:string;toProject:string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function workerMovePreviewEnabled():boolean {
 return process.env.NEXT_PUBLIC_ASSIGNMENT_HISTORY_PREVIEW==='true' && process.env.NEXT_PUBLIC_ATOMIC_WORKER_MOVE_PREVIEW==='true';
}
export function parseWorkerMoveAttempt(raw:unknown,actorId:string,fromProject:string):WorkerMoveAttempt {
 if(!raw || typeof raw!=='object' || Array.isArray(raw))throw Error('Invalid move retry');
 const r=raw as Record<string,unknown>;
 for(const key of ['requestId','actorId','workerId','fromProject','toProject'])if(typeof r[key]!=='string'||!uuid.test(r[key] as string))throw Error('Invalid move retry');
 if(r.actorId!==actorId||r.fromProject!==fromProject||r.fromProject===r.toProject)throw Error('Move retry belongs to another scope');
 return {requestId:r.requestId as string,actorId:r.actorId as string,workerId:r.workerId as string,fromProject:r.fromProject as string,toProject:r.toProject as string};
}
export function verifyWorkerMoveResult(raw:unknown,attempt:WorkerMoveAttempt):{replayed:boolean} {
 if(!raw || typeof raw!=='object' || Array.isArray(raw))throw Error('Invalid move result');
 const r=raw as Record<string,unknown>;
 if(r.request_id!==attempt.requestId||r.worker_id!==attempt.workerId||r.from_project!==attempt.fromProject||r.to_project!==attempt.toProject||typeof r.replayed!=='boolean')throw Error('Move not confirmed');
 return {replayed:r.replayed};
}
