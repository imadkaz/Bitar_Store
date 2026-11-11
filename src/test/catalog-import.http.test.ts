import 'dotenv/config';
import { vi } from 'vitest';

vi.hoisted(() => {
    process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
    process.env.AUTH_MODE = 'jwt';
});

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../db';
import { UserRole } from '../models/User.model';
import { UserRepository } from '../repositories/UserRepository';
import { JwtTokenService } from '../services/JwtTokenService';
import { createUserWithPassword } from '../test-helpers/createUserWithPassword';
import { waitForDatabase } from '../test-helpers/waitForDatabase';

// Importing the catalog sheet through the real rules of the API: a dry run by default, safe to run again, a cost already set is never overwritten.
const disposable = process.env.TEST_DB_DISPOSABLE === '1';
const stamp = Date.now();
const short = String(stamp).slice(-7);
const tokens = new JwtTokenService(process.env.JWT_SECRET!);
const as = (id: string) => ({ Authorization: `Bearer ${tokens.sign(id)}` });
const HEADER = 'model_code,product_name,category,sku,color,size,unit_cost_usd_est,sell_price_usd,material_as_written';
let adminId = '', managerEmail = '', employeeEmail = '', managerId = '';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
const write = (name: string, lines: string[]) => { const file = path.join(dir, name); fs.writeFileSync(file, [HEADER, ...lines].join('\n')); return file; };
const run = (args: string[], env: Record<string, string> = {}) => new Promise<{ code: number; out: string }>((resolve) => {
    execFile('npx', ['tsx', 'scripts/import-catalog.ts', ...args], { env: { ...process.env, ...env }, cwd: process.cwd(), timeout: 120_000 }, (error, stdout, stderr) => resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out: `${stdout}\n${stderr}` }));
});
const code = (tag: string) => `IM${short}${tag}`;
const PAJAMA = `Pajama ${short}`, JACKET = `Jacket ${short}`;          // new every run, so the test also passes on a database that was used before

describe.skipIf(!disposable)('importing the catalog sheet (real database)', () => {
    beforeAll(async () => {
        await waitForDatabase(prisma);
        const make = async (tag: string, role: UserRole) => { const email = `${tag}-${stamp}@bitar.test`; const id = (await createUserWithPassword(new UserRepository(prisma), { email, password: 'Password#123', fullName: `Test ${tag}`, role }, null)).getId(); return { id, email }; };
        adminId = (await make('imadmin', UserRole.ADMIN)).id;
        const mgr = await make('immgr', UserRole.MANAGER); managerEmail = mgr.email; managerId = mgr.id;
        employeeEmail = (await make('imstaff', UserRole.EMPLOYEE)).email;
    }, 120_000);

    it('a dry run checks everything and writes nothing; it says what is missing and what the sheet itself asks to confirm', async () => {
        const file = write('a.csv', [`${code('A')},Basic Line,${PAJAMA},${code('A')}-S,Blue,S,12,30,Oisho`, `${code('A')},Basic Line,${PAJAMA},${code('A')}-M,Blue,M,12,30,Oisho`, `${code('B')},Mary Rose,Dress,${code('B')}-S,Pink,S,18,,Linen`]);
        fs.writeFileSync(file.replace('.csv', '_review.csv'), `model_code,product_name,question,action\n${code('B')},Mary Rose,"Selling price missing; colors need confirmation",Please confirm\n`);
        const dry = await run(['--file', file, '--actor', managerEmail]);
        expect(dry.code, dry.out).toBe(0);
        expect(dry.out).toMatch(/styles to create: 1 -> .*Basic Line/);
        expect(dry.out).toMatch(new RegExp(`categories to create: 1 -> ${PAJAMA}`));
        expect(dry.out).toMatch(/skus to create:   2/);
        expect(dry.out).toMatch(/NOT imported, no selling price in the file: 1 skus/);
        expect(dry.out).toMatch(/need confirmation/);
        expect(dry.out).toMatch(/Mary Rose.*Selling price missing/);
        expect(dry.out).toMatch(/Dry run: nothing was written/);
        expect(await prisma.style.count({ where: { code: { startsWith: `IM${short}` } } })).toBe(0);
    });

    it('--yes creates the styles with their category and the skus with their price, sets the catalog costs, and the price history and the audit log are written', async () => {
        const file = write('b.csv', [`${code('C')},Basic Line,${PAJAMA},${code('C')}-S,Blue,S,12,30,Oisho`, `${code('C')},Basic Line,${PAJAMA},${code('C')}-36,Blue,36,12,30,Oisho`, `${code('D')},One Piece,${JACKET},${code('D')}-OS,Jeans,One Size,34,88.50,Jeans`, `${code('E')},No Price,Dress,${code('E')}-S,Pink,S,18,,Linen`]);
        const done = await run(['--file', file, '--actor', managerEmail, '--yes']);
        expect(done.code, done.out).toBe(0);
        expect(done.out).toMatch(new RegExp(`categories created: ${PAJAMA}, ${JACKET}`));
        expect(done.out).toMatch(/created 2 style\(s\) and 3 sku\(s\); 3 catalog cost\(s\) set/);
        expect(await prisma.category.count({ where: { name: { in: [PAJAMA, JACKET] } } })).toBe(2);
        expect(done.out).toMatch(/the sheet has no quantities/);
        const style = await prisma.style.findFirst({ where: { code: code('C') } });
        expect(style).toMatchObject({ name: 'Basic Line', category: PAJAMA });
        const skus = await prisma.sku.findMany({ where: { skuCode: { startsWith: `IM${short}` } }, orderBy: { skuCode: 'asc' } });
        expect(skus.map((s) => [s.skuCode, s.size, s.color, s.standardPrice.toFixed(2)])).toEqual([[`${code('C')}-36`, '36', 'Blue', '30.00'], [`${code('C')}-S`, 'S', 'Blue', '30.00'], [`${code('D')}-OS`, 'One Size', 'Jeans', '88.50']]);
        expect(await prisma.style.count({ where: { code: code('E') } })).toBe(0);                                           // no price: not created
        const cost = (await request(app).get(`/costs/skus/${skus[2].id}`).set(as(managerId))).body;
        expect(cost.catalogCost).toBe('34.0000');
        const history = await prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM sku_price_history WHERE sku_id = ANY(${skus.map((s) => s.id)}::uuid[])`;
        expect(history[0].n).toBe(3);                                                                                     // every sku starts its price history
        const audit = JSON.stringify((await request(app).get('/audit-events?entityType=category').set(as(adminId))).body) + JSON.stringify((await request(app).get(`/audit-events?entityType=sku&entityId=${skus[2].id}`).set(as(adminId))).body);
        expect(audit).toContain(PAJAMA);                                                                                  // the categories are audited ...
        expect(audit).toContain('sku.cost_set');                                                                          // ... and so are the costs
        // the products start with no stock: the sheet has no quantities
        expect(await prisma.stockBalance.count({ where: { skuId: { in: skus.map((s) => s.id) } } })).toBe(0);
    });

    it('running it again changes nothing, and a catalog cost already set is never overwritten', async () => {
        const file = write('c.csv', [`${code('F')},Dress,Dress,${code('F')}-S,Red,S,10,25,Linen`, `${code('F')},Dress,Dress,${code('F')}-M,Red,M,10,25,Linen`]);
        expect((await run(['--file', file, '--actor', managerEmail, '--yes'])).code).toBe(0);
        const sku = await prisma.sku.findFirstOrThrow({ where: { skuCode: `${code('F')}-S` } });
        expect((await request(app).put(`/costs/skus/${sku.id}`).set(as(managerId)).send({ unitCost: '11.75' })).status).toBe(200);       // the manager corrects a cost
        const again = await run(['--file', file, '--actor', managerEmail, '--yes']);
        expect(again.code, again.out).toBe(0);
        expect(again.out).toMatch(/skus to create:   0     already in the database \(skipped\): 2/);
        expect((await request(app).get(`/costs/skus/${sku.id}`).set(as(managerId))).body.catalogCost).toBe('11.7500');
        expect(await prisma.sku.count({ where: { skuCode: { startsWith: code('F') } } })).toBe(2);
        // a new sku of an EXISTING style: the style is reused
        const more = write('d.csv', [`${code('F')},Dress,Dress,${code('F')}-L,Red,L,10,25,Linen`]);
        const added = await run(['--file', more, '--actor', managerEmail, '--yes']);
        expect(added.out).toMatch(/created 0 style\(s\) and 1 sku\(s\)/);
        expect(await prisma.style.count({ where: { code: code('F') } })).toBe(1);
    });

    it('--no-costs leaves the costs alone (the costs of the sheet are estimates)', async () => {
        const file = write('e.csv', [`${code('G')},Dress,Dress,${code('G')}-S,Red,S,10,25,Linen`]);
        const done = await run(['--file', file, '--actor', managerEmail, '--yes', '--no-costs']);
        expect(done.out).toMatch(/catalog cost\(s\) set/);
        const sku = await prisma.sku.findFirstOrThrow({ where: { skuCode: `${code('G')}-S` } });
        expect((await request(app).get(`/costs/skus/${sku.id}`).set(as(managerId))).body.catalogCost).toBeNull();
    });

    it('a row the app would refuse stops everything before anything is written; a wrong actor, a missing file and a remote database are refused', async () => {
        const bad = write('f.csv', [`${code('H')},Dress,Dress,${code('H')}-S,Red,S,10,25,Linen`, `${code('H')},Dress,Dress,${code('H')} BAD,Red,M,10,25,Linen`]);
        const refused = await run(['--file', bad, '--actor', managerEmail, '--yes']);
        expect(refused.code).toBe(1);
        expect(refused.out).toMatch(/1 row\(s\) are refused.*NOTHING was written/s);
        expect(refused.out).toMatch(/line 3/);
        expect(await prisma.style.count({ where: { code: code('H') } })).toBe(0);
        const fine = write('g.csv', [`${code('I')},Dress,Dress,${code('I')}-S,Red,S,10,25,Linen`]);
        expect((await run(['--file', fine, '--actor', employeeEmail, '--yes'])).out).toMatch(/not an admin or a manager/);
        expect((await run(['--file', fine, '--yes'])).out).toMatch(/--actor/);
        expect((await run(['--file', path.join(dir, 'nope.csv'), '--actor', managerEmail])).out).toMatch(/Give the file/);
        const remote = await run(['--file', fine, '--actor', managerEmail, '--yes'], { DATABASE_URL: 'postgresql://u:p@ep-demo.neon.tech/db?sslmode=require' });
        expect(remote.code).not.toBe(0);
        expect(remote.out).toMatch(/remote \(Neon\) database/);
        expect(await prisma.style.count({ where: { code: code('I') } })).toBe(0);
        const wrongColumns = path.join(dir, 'h.csv'); fs.writeFileSync(wrongColumns, 'model_code,sku\nA,B\n');
        expect((await run(['--file', wrongColumns, '--actor', managerEmail])).out).toMatch(/no column/);
    });
});
