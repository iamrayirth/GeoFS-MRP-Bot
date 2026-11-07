import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { MIGRATIONS_FOLDER, type Db } from '../../src/db/client.js';
import { schema } from '../../src/db/schema.js';

/** Real PostgreSQL (WASM) with the production migrations applied - no mocks of SQL behaviour. */
export async function createTestDb(): Promise<{ db: Db; close(): Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db: db as unknown as Db, close: () => client.close() };
}
