// scripts/migrate.ts
//   npx tsx scripts/migrate.ts                           -> apply pending migrations
//   npx tsx scripts/migrate.ts baseline 001_foundation.sql -> mark as applied WITHOUT running
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations');
const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex');

async function main() {
    const [command, fileArg] = process.argv.slice(2);
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            filename   text PRIMARY KEY,
            checksum   text NOT NULL,
            applied_at timestamptz NOT NULL DEFAULT now()
        )`);

    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const applied = new Map<string, string>(
        (await client.query('SELECT filename, checksum FROM schema_migrations')).rows.map(
            (r) => [r.filename, r.checksum] as [string, string],
        ),
    );

    if (command === 'baseline') {
        if (!fileArg || !files.includes(fileArg)) throw new Error(`Unknown migration file: ${fileArg}`);
        const sql = readFileSync(join(MIGRATIONS_DIR, fileArg), 'utf8');
        await client.query(
            'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [fileArg, checksum(sql)],
        );
        console.log(`baselined ${fileArg}`);
        await client.end();
        return;
    }

    for (const file of files) {
        const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
        const sum = checksum(sql);
        if (applied.has(file)) {
            if (applied.get(file) !== sum) {
                throw new Error(`${file} was already applied but changed. Never edit an applied migration; add a new one.`);
            }
            continue;
        }
        console.log(`applying ${file} ...`);
        try {
            await client.query('BEGIN');
            await client.query(sql); // migration files must NOT contain BEGIN/COMMIT
            await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, sum]);
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            console.error(`FAILED ${file}, rolled back`);
            throw error;
        }
    }
    console.log('up to date');
    await client.end();
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });