'use client';
import React from 'react';
import {Select} from '@/components/ui/Select';
import {Button} from '@/components/ui/Button';
import type {WorkerCategory} from '@/lib/workforce/categoryCatalog';

type Categories={items:WorkerCategory[]|null;error:boolean;loading:boolean;retry:()=>void};
export function WorkerCategorySelect({categories,label,value,onChange,allowUnchanged=false}:{categories:Categories;label:string;value:string;onChange:(value:string)=>void;allowUnchanged?:boolean}){
 const active=categories.items?.some(c=>c.label===value)??false;
 const options=[{label:categories.loading?'Loading categories…':'Choose a category',value:''},...(allowUnchanged&&value&&!active?[{label:`${value} (existing; not available for new workers)`,value}]:[]),...(categories.items??[]).map(c=>({label:c.label,value:c.label}))];
 return <div><Select label={label} required disabled={!categories.items} value={value} onChange={e=>onChange(e.target.value)} options={options}/>{categories.error&&<p role="alert" className="mt-1 text-xs text-status-danger">Categories could not be verified. <Button type="button" variant="ghost" size="sm" onClick={categories.retry}>Retry categories</Button></p>}{categories.items?.length===0&&<p className="text-xs text-ink-secondary">The Founder must add an active category first.</p>}</div>;
}
