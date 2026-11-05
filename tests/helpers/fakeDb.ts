/**
 * Minimal in-memory stand-in for the Supabase PostgREST query builder,
 * covering only the query shapes used by the BALE communication services.
 */

type Row = Record<string, any>;

export interface FakeDb {
  from: (table: string) => any;
  tables: Record<string, Row[]>;
}

export function createFakeDb(seed: Record<string, Row[]> = {}): FakeDb {
  const tables: Record<string, Row[]> = JSON.parse(JSON.stringify(seed));
  let idCounter = 0;

  function from(table: string) {
    if (!tables[table]) tables[table] = [];
    const rows = tables[table];

    const filters: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'insert' | 'update' = 'select';
    let insertRow: Row | null = null;
    let updatePatch: Row | null = null;
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;
    let ignoreDuplicates = false;

    const exec = (): { data: Row[] | null; error: { code?: string; message: string } | null } => {
      if (op === 'insert') {
        const row: Row = {
          id: `fake-${table}-${++idCounter}`,
          created_at: new Date().toISOString(),
          ...insertRow,
        };
        if (
          row.idempotency_key &&
          rows.some((r) => r.idempotency_key === row.idempotency_key)
        ) {
          if (ignoreDuplicates) return { data: [], error: null };
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        }
        rows.push(row);
        return { data: [row], error: null };
      }

      let result = rows.filter((r) => filters.every((f) => f(r)));

      if (op === 'update') {
        result.forEach((r) => Object.assign(r, updatePatch));
        return { data: result, error: null };
      }

      if (orderCol) {
        result = [...result].sort((a, b) => {
          const av = a[orderCol as string] ?? '';
          const bv = b[orderCol as string] ?? '';
          return (av < bv ? -1 : av > bv ? 1 : 0) * (orderAsc ? 1 : -1);
        });
      }
      if (limitN !== null) result = result.slice(0, limitN);
      return { data: result, error: null };
    };

    const api: any = {
      select: () => api,
      insert: (r: Row) => {
        op = 'insert';
        insertRow = r;
        return api;
      },
      upsert: (r: Row, opts?: { ignoreDuplicates?: boolean }) => {
        op = 'insert';
        insertRow = r;
        ignoreDuplicates = Boolean(opts?.ignoreDuplicates);
        return api;
      },
      update: (p: Row) => {
        op = 'update';
        updatePatch = p;
        return api;
      },
      eq: (col: string, val: any) => {
        filters.push((r) => r[col] === val);
        return api;
      },
      in: (col: string, vals: any[]) => {
        filters.push((r) => vals.includes(r[col]));
        return api;
      },
      not: (col: string, operator: string, value: string) => {
        if (operator === 'in') {
          const list = value.replace(/^\(|\)$/g, '').split(',');
          filters.push((r) => !list.includes(String(r[col])));
        }
        return api;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderCol = col;
        orderAsc = opts?.ascending !== false;
        return api;
      },
      limit: (n: number) => {
        limitN = n;
        return api;
      },
      maybeSingle: async () => {
        const { data, error } = exec();
        return { data: data?.[0] ?? null, error };
      },
      single: async () => {
        const { data, error } = exec();
        if (error) return { data: null, error };
        const row = data?.[0] ?? null;
        return { data: row, error: row ? null : { message: 'Row not found' } };
      },
      then: (resolve: any, reject: any) => Promise.resolve(exec()).then(resolve, reject),
    };
    return api;
  }

  return { from, tables };
}

/** Fake Supabase client with auth + db for requireFounder-style checks. */
export function createFakeSupabase(
  db: FakeDb,
  user: { id: string; email?: string } | null
) {
  return {
    auth: {
      getUser: async () =>
        user
          ? { data: { user }, error: null }
          : { data: { user: null }, error: { message: 'Auth session missing' } },
    },
    from: db.from,
    rpc: async () => ({ data: true, error: null }),
  };
}
