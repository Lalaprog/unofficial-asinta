import { describe, expect, it } from 'vitest';
import { firstOfMonth, monthDates, parseCalendarCounts, shiftMonth, weekDates } from '@/lib/attendance/calendar';
describe('site calendar dates and validation',()=>{
 it('handles leap years, months, and week boundaries independently of time zone',()=>{
  expect(firstOfMonth('2024-02-29')).toBe('2024-02-01');
  expect(monthDates('2024-02-01').filter(Boolean)).toHaveLength(29);
  expect(shiftMonth('2026-12-01',1)).toBe('2027-01-01');
  expect(weekDates('2026-11-01')).toEqual(['2026-11-01','2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06','2026-11-07']);
  expect(weekDates('2026-10-31')[0]).toBe('2026-10-25');
 });
 it('rejects wrong range, duplicate days and malformed counts',()=>{
  expect(parseCalendarCounts([{date:'2026-09-25',count:1},{date:'2026-11-06',count:2}],'2026-10-01').size).toBe(2);
  for(const input of [[{date:'2026-09-24',count:1}], [{date:'2026-10-01',count:0}], [{date:'2026-10-01',count:2},{date:'2026-10-01',count:3}], null]) expect(()=>parseCalendarCounts(input,'2026-10-01')).toThrow();
 });
});
