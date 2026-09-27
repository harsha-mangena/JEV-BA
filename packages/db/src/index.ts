import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

export type Queryable = Pick<pg.PoolClient, 'query'>;

const MIGRATIONS = join(import.meta.dirname, '../migrations');

export class Db {
  readonly pool: pg.Pool;

  constructor(connectionString: string, opts: { schema?: string; max?: number } = {}) {
    this.pool = new pg.Pool({
      connectionString,
      max: opts.max ?? 10,
      ...(opts.schema ? { options: `-c search_path=${opts.schema}` } : {}),
    });
  }

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(sql, params);
  }

  async one<R extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<R | undefined> {
    return (await this.pool.query<R>(sql, params)).rows[0];
  }

  /** Run `fn` in a transaction; rolls back on any error. */
  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      const r = await fn(c);
      await c.query('commit');
      return r;
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  /** Apply pending migrations in filename order, each in its own transaction. */
  async migrate(): Promise<string[]> {
    await this.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const applied = new Set((await this.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
    const ran: string[] = [];
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = await readFile(join(MIGRATIONS, f), 'utf8');
      await this.tx(async (c) => {
        await c.query(sql);
        await c.query('insert into schema_migrations(name) values ($1)', [f]);
      });
      ran.push(f);
    }
    return ran;
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

/** Create an isolated schema (tests, previews) and return a Db bound to it. */
export async function createIsolatedDb(connectionString: string, schema: string): Promise<Db> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`invalid schema name ${schema}`);
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  try {
    await admin.query(`create schema if not exists ${schema}`);
  } finally {
    await admin.end();
  }
  const db = new Db(connectionString, { schema });
  await db.migrate();
  return db;
}

export async function dropSchema(connectionString: string, schema: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`invalid schema name ${schema}`);
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  try {
    await admin.query(`drop schema if exists ${schema} cascade`);
  } finally {
    await admin.end();
  }
}
