// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/projects/preparePhoto', async (importOriginal)=>{const actual=await importOriginal<typeof import('@/lib/projects/preparePhoto')>();return {...actual,prepareProjectPhoto:vi.fn(async(file:File)=>file)};});
import { ProjectPhotoManager } from '@/components/projects/ProjectPhotoManager';
import { ProjectCover } from '@/components/projects/ProjectCover';
const id='11111111-1111-4111-8111-111111111111';
beforeEach(()=>{
  vi.stubGlobal('fetch',vi.fn(async (_url:string, options?:RequestInit)=>({ok:true,json:async()=>options?.method==='PUT'?{hasPhoto:true,version:'22222222-2222-4222-8222-222222222222'}:{hasPhoto:false,version:null}})));
  URL.createObjectURL=vi.fn(()=> 'blob:preview');URL.revokeObjectURL=vi.fn();
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('project photo controls',()=>{
 it('uses the exact blueprint fallback without obscuring card content',()=>{
  const {container}=render(React.createElement(ProjectCover,{projectId:id,children:React.createElement('span',null,'Project')}));
  expect((container.firstChild as HTMLElement).style.backgroundImage).toContain('/brand/project-blueprint.webp');expect(screen.getByText('Project')).toBeTruthy();
  fireEvent.error(container.querySelector('img')!);expect(container.querySelector('img')).toBeNull();
 });
 it('keeps selections when collapsed and uploads only after explicit save',async()=>{
  render(React.createElement(ProjectPhotoManager,{projectId:id}));fireEvent.click(screen.getByRole('button',{name:'Manage photo'}));
  const input=await screen.findByLabelText('Choose a photo');const file=new File(['abc'],'site.jpg',{type:'image/jpeg'});fireEvent.change(input,{target:{files:[file]}});
  await screen.findByText('Preview of the selected photo. Save to apply it.');
  fireEvent.click(screen.getByRole('button',{name:'Close photo editor'}));expect(input.closest('[hidden]')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Manage photo'}));expect(screen.getByText('Preview of the selected photo. Save to apply it.')).toBeTruthy();
  expect(vi.mocked(fetch).mock.calls.filter(([,opts])=>opts?.method==='PUT')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button',{name:'Save photo'}));await waitFor(()=>expect(screen.getByText(/Photo saved/)).toBeTruthy());
  expect(vi.mocked(fetch).mock.calls.filter(([,opts])=>opts?.method==='PUT')).toHaveLength(1);
 });
 it('shows preparation feedback and only sends after preparation succeeds',async()=>{
  const prepare=vi.mocked((await import('@/lib/projects/preparePhoto')).prepareProjectPhoto);
  let finish!:(file:File)=>void;prepare.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));
  render(React.createElement(ProjectPhotoManager,{projectId:id}));fireEvent.click(screen.getByRole('button',{name:'Manage photo'}));const input=await screen.findByLabelText('Choose a photo');
  const original=new File([new Uint8Array(4*1024*1024)],'phone.jpg',{type:'image/jpeg'});fireEvent.change(input,{target:{files:[original]}});fireEvent.click(screen.getByRole('button',{name:'Save photo'}));
  expect((screen.getByRole('button',{name:'Preparing and saving…'}) as HTMLButtonElement).disabled).toBe(true);expect(vi.mocked(fetch).mock.calls.every(([,opts])=>opts?.method!=='PUT')).toBe(true);
  const optimized=new File(['small'],'project-photo.jpg',{type:'image/jpeg'});finish(optimized);await waitFor(()=>expect(screen.getByText(/Photo saved/)).toBeTruthy());
  const request=vi.mocked(fetch).mock.calls.find(([,opts])=>opts?.method==='PUT')!;expect((request[1]!.body as FormData).get('photo')).toBe(optimized);
 });
 it('rejects unsupported and large files before uploading',async()=>{
  render(React.createElement(ProjectPhotoManager,{projectId:id}));fireEvent.click(screen.getByRole('button',{name:'Manage photo'}));const input=await screen.findByLabelText('Choose a photo');
  fireEvent.change(input,{target:{files:[new File(['x'],'bad.gif',{type:'image/gif'})]}});expect(screen.getByRole('alert').textContent).toContain('JPEG');
  fireEvent.change(input,{target:{files:[new File([new Uint8Array(20*1024*1024+1)],'big.jpg',{type:'image/jpeg'})]}});expect(screen.getByRole('alert').textContent).toContain('20 MB');expect(vi.mocked(fetch).mock.calls.every(([,opts])=>!opts?.method)).toBe(true);
 });
});
