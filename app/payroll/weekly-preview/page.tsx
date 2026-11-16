import {notFound} from 'next/navigation';
import {WeeklyFinanceWalkthrough} from '@/components/payroll/WeeklyFinanceWalkthrough';

// Only a Vercel preview deployment can serve this illustrative page. It does
// not enable finance gates or prove the preview uses an isolated backend.
export const dynamic = 'force-dynamic';
export default function WeeklyFinanceWalkthroughPage(){
 if(process.env.VERCEL_ENV!=='preview')notFound();
 return <WeeklyFinanceWalkthrough />;
}
