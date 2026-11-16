'use client';
import {ownedEquipmentPreviewEnabled} from '@/lib/tools/ownedEquipment';
import {OwnedEquipmentManager} from './OwnedEquipmentManager';
/** Display switch only; the database must separately verify Founder assurance. */
export function OwnedEquipmentFoundation({userId,isFounder,assurance,authLoading}:{userId:string|undefined;isFounder:boolean;assurance:string;authLoading:boolean}){
 if(!ownedEquipmentPreviewEnabled()||!userId||!isFounder||assurance!=='ready'||authLoading)return null;
 return <OwnedEquipmentManager key={userId} userId={userId}/>;
}
