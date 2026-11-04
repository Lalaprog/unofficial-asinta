// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {SearchableSelect} from '@/components/ui/SearchableSelect';
const options=Array.from({length:10},(_,index)=>({value:`id-${index}`,label:index===8?'Luna Construction':'Client '+index}));
afterEach(()=>cleanup());
function Fixture({initial='',required=false}:{initial?:string;required?:boolean}) {
  const [value,setValue]=React.useState(initial);
  return React.createElement(SearchableSelect,{
    label:'Client',searchLabel:'Search clients',fixedOption:{value:'',label:'Select a client...'},options,value,required,
    onChange:(event:React.ChangeEvent<HTMLSelectElement>)=>setValue(event.target.value),
  });
}
function openSearch(){fireEvent.click(screen.getByRole('button',{name:'Search clients'}));return screen.getByRole('searchbox',{name:'Search clients'})}

describe('native select with optional search',()=>{
  it('leaves short lists and native required validation unchanged',()=>{
    render(React.createElement(SearchableSelect,{label:'Client',searchLabel:'Search clients',value:'',required:true,onChange:vi.fn(),fixedOption:{value:'',label:'Choose'},options:options.slice(0,2)}));
    expect(screen.queryByRole('button',{name:'Search clients'})).toBeNull();
    const select=screen.getByRole('combobox',{name:'Client'}) as HTMLSelectElement;
    expect(select.required).toBe(true);expect(select.checkValidity()).toBe(false);expect(within(select).getAllByRole('option')).toHaveLength(3);
  });
  it('filters names case-insensitively without changing selection, then restores all options',()=>{
    render(React.createElement(Fixture,{initial:'id-0'}));const search=openSearch();
    fireEvent.change(search,{target:{value:' luna '}});
    const select=screen.getByRole('combobox',{name:'Client'}) as HTMLSelectElement;
    expect(select.value).toBe('id-0');expect(within(select).getAllByRole('option').map(option=>option.textContent)).toEqual(['Select a client...','Client 0','Luna Construction']);
    expect(screen.getByRole('status').textContent).toContain('Your current selection remains available');
    fireEvent.change(select,{target:{value:'id-8'}});expect(select.value).toBe('id-8');
    fireEvent.click(screen.getByRole('button',{name:'Close search clients'}));expect(select.value).toBe('id-8');expect(within(select).getAllByRole('option')).toHaveLength(11);
  });
  it('explains no matches without dropping the selected value',()=>{
    render(React.createElement(Fixture,{initial:'id-0'}));fireEvent.change(openSearch(),{target:{value:'no such client'}});
    const select=screen.getByRole('combobox',{name:'Client'}) as HTMLSelectElement;
    expect(select.value).toBe('id-0');expect(within(select).getAllByRole('option')).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toContain('No matching options.');
  });
  it('does not submit the parent form when Enter is pressed in search',()=>{
    const submit=vi.fn((event:React.FormEvent)=>event.preventDefault());
    render(React.createElement('form',{onSubmit:submit},React.createElement(Fixture),React.createElement('button',{type:'submit'},'Save')));
    const search=openSearch();const prevented=!fireEvent.keyDown(search,{key:'Enter',code:'Enter'});
    expect(prevented).toBe(true);expect(submit).not.toHaveBeenCalled();
  });
  it('keeps externally unavailable current selections when supplied as options',()=>{
    render(React.createElement(SearchableSelect,{label:'Site',searchLabel:'Search sites',value:'missing',onChange:vi.fn(),fixedOption:{value:'',label:'Depot'},options:[{value:'missing',label:'Assigned project unavailable'},...options]}));
    fireEvent.change(openSearchForSite(),{target:{value:'Luna'}});
    const select=screen.getByRole('combobox',{name:'Site'}) as HTMLSelectElement;expect(select.value).toBe('missing');expect(within(select).getByRole('option',{name:'Assigned project unavailable'})).toBeTruthy();
  });
});
function openSearchForSite(){fireEvent.click(screen.getByRole('button',{name:'Search sites'}));return screen.getByRole('searchbox',{name:'Search sites'})}
