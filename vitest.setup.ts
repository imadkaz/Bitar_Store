// vitest.setup.ts
const url = process.env.DATABASE_URL ?? '';
if (/neon\.tech/i.test(url)) {
    throw new Error('Refusing to run the tests on Neon. Use a local database: export DATABASE_URL=postgresql://postgres:test@localhost:5433/bitar_test');
}