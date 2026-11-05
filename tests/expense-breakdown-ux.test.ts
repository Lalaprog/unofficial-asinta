// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExpenseItemsEditor } from '@/components/expenses/ExpenseItemsEditor';
import { ExpenseDetailsModal } from '@/components/expenses/ExpenseDetailsModal';
import type { Expense } from '@/types';
import type { ItemInput } from '@/lib/expenses/items';

afterEach(cleanup);
function EditorFixture() {
  const [rows, setRows] = React.useState<ItemInput[]>([]);
  return React.createElement(ExpenseItemsEditor, {rows,onChange:setRows,receiptTotal:'100'});
}
const expense:Expense = {id:'e1',project_id:'p1',description:'Materials',details:'Delivery for site',category:'materials',amount:100,expense_date:'2026-11-01',receipt_url:null,notes:'OR 123',vendor:'Shop',line_items:[{name:'Cement',quantity:'2 bags',amount:75}],revision:2,ai_category_suggestion:null,ai_bale_detection:false,ai_confirmed:false,created_by:'founder',created_at:'2026-11-01'};
describe('expense breakdown interface', () => {
  it('adds and removes rows and shows a difference without changing the receipt total', () => {
    render(React.createElement(EditorFixture));
    fireEvent.click(screen.getByRole('button',{name:'Add item'}));
    fireEvent.change(screen.getByLabelText('Item 1'),{target:{value:'Cement'}});
    fireEvent.change(screen.getByLabelText('Quantity 1'),{target:{value:'2 bags'}});
    fireEvent.change(screen.getByLabelText('Item amount 1 (₱)'),{target:{value:'75'}});
    expect(screen.getByText(/Difference from receipt total/).textContent).toContain('25.00');
    fireEvent.click(screen.getByRole('button',{name:'Remove item 1'}));
    expect(screen.queryByLabelText('Item 1')).toBeNull();
  });
  it('shows title, details, item list and uses the loaded revision to save edits', async () => {
    const update=vi.fn().mockResolvedValue({...expense,revision:3}); const close=vi.fn();
    render(React.createElement(ExpenseDetailsModal,{expense,projects:[{id:'p1',name:'Site'}],onClose:close,onUpdate:update,onReceipt:vi.fn()}));
    const dialog=screen.getByRole('dialog',{name:'Expense details'});
    expect(within(dialog).getByText('Materials')).toBeTruthy();
    expect(within(dialog).getByText('Delivery for site')).toBeTruthy();
    expect(within(dialog).getByText('Cement')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button',{name:'Edit expense'}));
    const edit=screen.getByRole('dialog',{name:'Edit expense'});
    fireEvent.change(within(edit).getByLabelText('Description'),{target:{value:'Reviewed'}});
    fireEvent.click(within(edit).getByRole('button',{name:'Save changes'}));
    await waitFor(()=>expect(update).toHaveBeenCalledWith('e1',expect.objectContaining({details:'Reviewed',amount:100,line_items:[{name:'Cement',quantity:'2 bags',amount:75}]}),2));
    expect(close).toHaveBeenCalled();
  });
  it('displays a failed or conflicting save without closing or retrying', async () => {
    const update=vi.fn().mockResolvedValue(null); const close=vi.fn();
    render(React.createElement(ExpenseDetailsModal,{expense,projects:[{id:'p1',name:'Site'}],onClose:close,onUpdate:update,onReceipt:vi.fn()}));
    fireEvent.click(screen.getByRole('button',{name:'Edit expense'}));
    fireEvent.click(screen.getByRole('button',{name:'Save changes'}));
    expect((await screen.findByRole('alert')).textContent).toContain('not confirmed');
    expect(close).not.toHaveBeenCalled(); expect(update).toHaveBeenCalledTimes(1);
  });
});
