// @vitest-environment jsdom
import React from 'react';
import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({mount:vi.fn()}));
vi.mock('@/components/workforce/WorkerCategoryManager',()=>({WorkerCategoryManager:()=>{mock.mount();return React.createElement('div',null,'Catalog preview');}}));
import {WorkerCategoryFoundation} from '@/components/workforce/WorkerCategoryFoundation';
afterEach(()=>{cleanup();vi.unstubAllEnvs();mock.mount.mockReset();});
describe('worker category preview display gate',()=>{
 it('does not mount on default/off values',()=>{
  for(const value of [undefined,'false','TRUE','1']){
   vi.stubEnv('NEXT_PUBLIC_WORKER_CATEGORY_PREVIEW',value);const v=render(React.createElement(WorkerCategoryFoundation,{userId:'u',isFounder:true,assurance:'ready',authLoading:false}));expect(mock.mount).not.toHaveBeenCalled();v.unmount();
  }
 });
 it('requires a ready Founder and identity even when explicitly enabled',()=>{
  vi.stubEnv('NEXT_PUBLIC_WORKER_CATEGORY_PREVIEW','true');
  for(const props of [{userId:'u',isFounder:false,assurance:'ready',authLoading:false},{userId:'u',isFounder:true,assurance:'pending',authLoading:false},{userId:'u',isFounder:true,assurance:'ready',authLoading:true},{userId:undefined,isFounder:true,assurance:'ready',authLoading:false}]){const v=render(React.createElement(WorkerCategoryFoundation,props));expect(mock.mount).not.toHaveBeenCalled();v.unmount();}
  render(React.createElement(WorkerCategoryFoundation,{userId:'u',isFounder:true,assurance:'ready',authLoading:false}));expect(screen.getByText('Catalog preview')).toBeTruthy();expect(mock.mount).toHaveBeenCalledTimes(1);
 });
});
