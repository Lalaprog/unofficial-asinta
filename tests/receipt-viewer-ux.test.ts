// @vitest-environment jsdom
import React, {useState} from 'react';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, describe, expect, it} from 'vitest';
import {Modal} from '@/components/ui/Modal';
import {ReceiptPhotoViewer} from '@/components/expenses/ReceiptPhotoViewer';
afterEach(cleanup);
function Fixture() {
  const [open,setOpen]=useState(true); const [photo,setPhoto]=useState(false);
  return React.createElement(React.Fragment,null,
    React.createElement(Modal,{isOpen:open,onClose:()=>setOpen(false),title:'Expense',presentation:'workspace',children:React.createElement('button',{onClick:()=>setPhoto(true)},'Open photo')}),
    React.createElement(ReceiptPhotoViewer,{isOpen:photo,src:'blob:synthetic',onClose:()=>setPhoto(false)}));
}
describe('receipt viewer',()=>{
  it('opens above the expense, zooms, and Escape only closes the top dialog',async()=>{
    render(React.createElement(Fixture));
    const expense=screen.getByRole('dialog',{name:'Expense'});
    fireEvent.click(screen.getByRole('button',{name:'Open photo'}));
    const viewer=screen.getByRole('dialog',{name:'Receipt photo'});
    expect(expense.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(within(viewer).getByRole('button',{name:'Zoom in'})); expect(within(viewer).getByText('150%')).toBeTruthy();
    fireEvent.keyDown(window,{key:'Escape'});
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Receipt photo'})).toBeNull());
    expect(screen.getByRole('dialog',{name:'Expense'})).toBeTruthy();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(window,{key:'Escape'});
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Expense'})).toBeNull());
    expect(document.body.style.overflow).not.toBe('hidden');
  });
});
