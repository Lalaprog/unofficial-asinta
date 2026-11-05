import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20261105000002_expense_breakdown.sql', 'utf8');
describe('expense breakdown migration', () => {
  it('preserves historical totals, validates new breakdowns, and prevents stale edits when revisions are checked', async () => {
    const db = new PGlite();
    try {
      await db.exec(`create table public.expenses (id integer primary key, description text, amount numeric(12,2)); insert into public.expenses values (1, 'Old expense', 100);`);
      await db.exec(migration);
      const old = (await db.query('select description, amount, details, line_items, revision from public.expenses where id=1')).rows[0];
      expect(old).toMatchObject({description:'Old expense', amount:'100.00', details:null, line_items:null, revision:0});
      await db.query('update public.expenses set details=$1, line_items=$2::jsonb where id=1 and revision=0', ['Reviewed',JSON.stringify([{name:'Cement',quantity:'10 bags',amount:75.25}])]);
      const row = (await db.query('select amount, revision, line_items from public.expenses where id=1')).rows[0];
      expect(row).toMatchObject({amount:'100.00',revision:1,line_items:[{name:'Cement',quantity:'10 bags',amount:75.25}]});
      expect((await db.query("update public.expenses set description='stale' where id=1 and revision=0 returning id")).rows).toHaveLength(0);
      for (const bad of [{},[{name:'',quantity:null,amount:1}],[{name:'x',quantity:null,amount:-1}],[{name:'x',quantity:null,amount:2.001}],[{name:'x',amount:'20'}]]) {
        await expect(db.query('update public.expenses set line_items=$1::jsonb where id=1',[JSON.stringify(bad)])).rejects.toThrow();
      }
      await expect(db.query('update public.expenses set details=$1 where id=1',['x'.repeat(5001)])).rejects.toThrow();
      expect((await db.query('select revision from public.expenses where id=1')).rows[0]).toMatchObject({revision:1});
    } finally { await db.close(); }
  });
});
