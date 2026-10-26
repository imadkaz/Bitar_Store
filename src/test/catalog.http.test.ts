import 'dotenv/config';
import { vi } from 'vitest';

vi.hoisted(() => {
    process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
    process.env.AUTH_MODE = 'jwt';
});

import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../db';
import { UserRole } from '../models/User.model';
import { UserRepository } from '../repositories/UserRepository';
import { JwtTokenService } from '../services/JwtTokenService';
import { createUserWithPassword } from '../test-helpers/createUserWithPassword';
import { waitForDatabase } from '../test-helpers/waitForDatabase';

const stamp = Date.now();
const prefix = `CT${stamp}`;                       // every style/sku/barcode made here starts with this, so cleanup is exact
const mail = (tag: string) => `${tag}-${stamp}@bitar.test`;
const repo = new UserRepository(prisma);
const tokens = new JwtTokenService(process.env.JWT_SECRET!);
const as = (id: string) => ({ Authorization: `Bearer ${tokens.sign(id)}` });
let adminId = '';
let managerId = '';
let employeeId = '';

beforeAll(async () => {
    await waitForDatabase(prisma);
    adminId = (await createUserWithPassword(repo, { email: mail('cadmin'), password: 'Password#123', fullName: 'Cat Admin', role: UserRole.ADMIN }, null)).getId();
    managerId = (await createUserWithPassword(repo, { email: mail('cmanager'), password: 'Password#123', fullName: 'Cat Manager', role: UserRole.MANAGER }, adminId)).getId();
    employeeId = (await createUserWithPassword(repo, { email: mail('cemployee'), password: 'Password#123', fullName: 'Cat Employee', role: UserRole.EMPLOYEE }, adminId)).getId();
}, 60_000);

afterAll(async () => {
    const styles = await prisma.style.findMany({ where: { code: { startsWith: prefix } }, select: { id: true } });
    const styleIds = styles.map((s) => s.id);
    const skus = await prisma.sku.findMany({ where: { styleId: { in: styleIds } }, select: { id: true } });
    const skuIds = skus.map((s) => s.id);
    await prisma.barcode.deleteMany({ where: { skuId: { in: skuIds } } });
    await prisma.skuPriceHistory.deleteMany({ where: { skuId: { in: skuIds } } });
    await prisma.sku.deleteMany({ where: { id: { in: skuIds } } });
    await prisma.style.deleteMany({ where: { id: { in: styleIds } } });
    const users = await prisma.user.findMany({ where: { email: { endsWith: `-${stamp}@bitar.test` } }, select: { id: true } });
    await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
}, 60_000);

// small builders: each test makes its own data, so tests never depend on each other
let counter = 0;
const nextCode = (tag: string) => `${prefix}-${tag}${++counter}`;
async function makeStyle(overrides: Record<string, unknown> = {}) {
    const res = await request(app).post('/styles').set(as(managerId)).send({ code: nextCode('S'), name: 'Nike Club Tee', category: 'Clothing', ...overrides });
    expect(res.status).toBe(201);
    return res.body as { id: string; code: string; name: string };
}
async function makeSku(styleId: string, overrides: Record<string, unknown> = {}) {
    const res = await request(app).post('/skus').set(as(managerId)).send({ styleId, skuCode: nextCode('K'), size: 'M', color: 'Red', standardPrice: '25.00', ...overrides });
    expect(res.status).toBe(201);
    return res.body as { id: string; skuCode: string; standardPrice: string };
}

describe('catalog permissions', () => {
    it('needs a login for everything', async () => {
        expect((await request(app).get('/styles')).status).toBe(401);
        expect((await request(app).get('/skus')).status).toBe(401);
        expect((await request(app).get('/skus/lookup?code=x')).status).toBe(401);
        expect((await request(app).post('/styles').send({})).status).toBe(401);
    });

    it('an employee can read and scan but cannot change anything', async () => {
        const style = await makeStyle();
        const sku = await makeSku(style.id);
        const e = as(employeeId);
        expect((await request(app).get('/styles').set(e)).status).toBe(200);
        expect((await request(app).get(`/styles/${style.id}`).set(e)).status).toBe(200);
        expect((await request(app).get('/skus').set(e)).status).toBe(200);
        expect((await request(app).get(`/skus/${sku.id}`).set(e)).status).toBe(200);
        expect((await request(app).get(`/skus/lookup?code=${sku.skuCode}`).set(e)).status).toBe(200);

        expect((await request(app).post('/styles').set(e).send({ code: nextCode('S'), name: 'X' })).status).toBe(403);
        expect((await request(app).patch(`/styles/${style.id}`).set(e).send({ name: 'Y' })).status).toBe(403);
        expect((await request(app).post('/skus').set(e).send({})).status).toBe(403);
        expect((await request(app).patch(`/skus/${sku.id}`).set(e).send({ size: 'L' })).status).toBe(403);
        expect((await request(app).put(`/skus/${sku.id}/price`).set(e).send({ price: '1.00' })).status).toBe(403);
        expect((await request(app).get(`/skus/${sku.id}/price-history`).set(e)).status).toBe(403);
        expect((await request(app).post(`/skus/${sku.id}/barcodes`).set(e).send({ code: '123' })).status).toBe(403);
        expect((await request(app).delete(`/barcodes/${randomUUID()}`).set(e)).status).toBe(403);
    });
});

describe('styles', () => {
    it('creates a style: the code is stored upper case, the response lists fields one by one', async () => {
        const code = nextCode('s').toLowerCase();
        const res = await request(app).post('/styles').set(as(managerId)).send({ code, name: '  Polo Shirt ', category: ' Tops ', isAdmin: true, id: 'chosen-by-client' });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ code: code.toUpperCase(), name: 'Polo Shirt', category: 'Tops', isActive: true });
        expect(res.body.id).not.toBe('chosen-by-client');
        expect(Object.keys(res.body).sort()).toEqual(['category', 'code', 'createdAt', 'id', 'isActive', 'name', 'updatedAt']);
        const row = await prisma.style.findUnique({ where: { id: res.body.id } });
        expect(row?.createdBy).toBe(managerId);
    });

    it('refuses a duplicate code whatever its letter case (409) and bad input (400)', async () => {
        const style = await makeStyle();
        expect((await request(app).post('/styles').set(as(managerId)).send({ code: style.code.toLowerCase(), name: 'Copy' })).status).toBe(409);
        const bad = [
            {}, { name: 'No code' }, { code: nextCode('S') }, { code: nextCode('S'), name: '   ' },
            { code: 'has space', name: 'X' }, { code: '$$$', name: 'X' }, { code: 'A'.repeat(41), name: 'X' },
            { code: nextCode('S'), name: 'N'.repeat(121) }, { code: nextCode('S'), name: 'X', category: 5 },
            { code: nextCode('S'), name: 'X', category: 'C'.repeat(61) }, { code: 123, name: 'X' },
        ];
        for (const body of bad) expect((await request(app).post('/styles').set(as(managerId)).send(body)).status).toBe(400);
        expect((await request(app).post('/styles').set(as(managerId))).status).toBe(400);   // no body at all
    });

    it('lists with search (code or name, any case), activeOnly and paging', async () => {
        const a = await makeStyle({ name: `Zeta Hoodie ${stamp}` });
        const b = await makeStyle({ name: `Alpha Hoodie ${stamp}` });
        await request(app).patch(`/styles/${b.id}`).set(as(managerId)).send({ isActive: false });

        const found = await request(app).get(`/styles?search=hoodie ${stamp}`).set(as(employeeId));
        expect(found.body.map((s: { id: string }) => s.id)).toEqual([b.id, a.id]);                 // sorted by name
        const byCode = await request(app).get(`/styles?search=${a.code.toLowerCase()}`).set(as(employeeId));
        expect(byCode.body.map((s: { id: string }) => s.id)).toEqual([a.id]);
        const active = await request(app).get(`/styles?search=hoodie ${stamp}&activeOnly=true`).set(as(employeeId));
        expect(active.body.map((s: { id: string }) => s.id)).toEqual([a.id]);
        const page = await request(app).get(`/styles?search=hoodie ${stamp}&limit=1&offset=1`).set(as(employeeId));
        expect(page.body.map((s: { id: string }) => s.id)).toEqual([a.id]);
    });

    it('refuses bad query values with 400', async () => {
        for (const q of ['limit=0', 'limit=201', 'limit=abc', 'limit=1.5', 'offset=-1', 'activeOnly=maybe', 'search=' + 'x'.repeat(101)]) {
            expect((await request(app).get(`/styles?${q}`).set(as(employeeId))).status).toBe(400);
        }
    });

    it('shows one style with its skus; unknown or malformed id is 404', async () => {
        const style = await makeStyle();
        const s1 = await makeSku(style.id, { size: 'S' });
        const s2 = await makeSku(style.id, { size: 'L' });
        const res = await request(app).get(`/styles/${style.id}`).set(as(employeeId));
        expect(res.status).toBe(200);
        expect(res.body.skus.map((s: { id: string }) => s.id).sort()).toEqual([s1.id, s2.id].sort());
        expect((await request(app).get(`/styles/${randomUUID()}`).set(as(employeeId))).status).toBe(404);
        expect((await request(app).get('/styles/abc').set(as(employeeId))).status).toBe(404);
    });

    it('updates name, category and the active flag; the code never changes', async () => {
        const style = await makeStyle({ category: 'Tops' });
        const res = await request(app).patch(`/styles/${style.id}`).set(as(managerId)).send({ name: 'Renamed', category: null, isActive: false, code: 'NEWCODE' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ name: 'Renamed', category: null, isActive: false, code: style.code });
        const row = await prisma.style.findUnique({ where: { id: style.id } });
        expect(row?.updatedBy).toBe(managerId);
        expect(row?.version).toBeGreaterThan(1);                                                    // the touch trigger ran
        expect((await request(app).patch(`/styles/${style.id}`).set(as(managerId)).send({ isActive: 'no' })).status).toBe(400);
        expect((await request(app).patch(`/styles/${style.id}`).set(as(managerId)).send({ name: ' ' })).status).toBe(400);
        expect((await request(app).patch(`/styles/${style.id}`).set(as(managerId))).status).toBe(200);   // empty update is a no-op
        expect((await request(app).patch(`/styles/${randomUUID()}`).set(as(managerId)).send({ name: 'X' })).status).toBe(404);
        expect((await request(app).patch('/styles/abc').set(as(managerId)).send({ name: 'X' })).status).toBe(404);
    });
});

describe('skus', () => {
    it('creates a sku with the price as a "25.00" string, USD by default, and records its first price', async () => {
        const style = await makeStyle();
        const res = await request(app).post('/skus').set(as(managerId)).send({ styleId: style.id, skuCode: nextCode('k').toLowerCase(), size: ' M ', color: ' Red ', standardPrice: 25 });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ styleId: style.id, size: 'M', color: 'Red', standardPrice: '25.00', currency: 'USD', isActive: true });
        expect(res.body.skuCode).toMatch(/^CT\d+-K\d+$/);                                          // stored upper case
        const history = await request(app).get(`/skus/${res.body.id}/price-history`).set(as(managerId));
        expect(history.body).toHaveLength(1);
        expect(history.body[0]).toMatchObject({ oldPrice: null, newPrice: '25.00', changedBy: managerId });
    });

    it('accepts prices as numbers or strings and refuses everything else (400)', async () => {
        const style = await makeStyle();
        const ok: [unknown, string][] = [[25.5, '25.50'], ['0', '0.00'], ['19.9', '19.90'], [0.07, '0.07'], ['9999999999.99', '9999999999.99']];
        let n = 0;
        for (const [input, shown] of ok) {
            const res = await request(app).post('/skus').set(as(managerId)).send({ styleId: style.id, skuCode: nextCode('K'), size: `P${++n}`, color: 'Blue', standardPrice: input });
            expect(res.status).toBe(201);
            expect(res.body.standardPrice).toBe(shown);
        }
        const bad = ['abc', '-1', -1, '1.234', 0.1 + 0.2, '', null, undefined, '1e3', 1e21, '10000000000.00', {}, [], true];
        for (const input of bad) {
            const res = await request(app).post('/skus').set(as(managerId)).send({ styleId: style.id, skuCode: nextCode('K'), size: `Q${++n}`, color: 'Blue', standardPrice: input });
            expect(res.status, `price ${JSON.stringify(input)}`).toBe(400);
        }
    });

    it('currency: lower case is accepted and stored upper case, anything else is refused', async () => {
        const style = await makeStyle();
        const eur = await request(app).post('/skus').set(as(managerId)).send({ styleId: style.id, skuCode: nextCode('K'), size: 'M', color: 'Red', standardPrice: '5', currency: 'eur' });
        expect(eur.body.currency).toBe('EUR');
        for (const currency of ['EURO', 'E1', 5, '']) {
            const res = await request(app).post('/skus').set(as(managerId)).send({ styleId: style.id, skuCode: nextCode('K'), size: 'L', color: 'Red', standardPrice: '5', currency });
            expect(res.status).toBe(400);
        }
    });

    it('refuses: unknown or inactive style, a duplicate code or variant (any case and spacing), bad fields', async () => {
        const style = await makeStyle();
        const sku = await makeSku(style.id, { size: 'M', color: 'Red' });
        const base = { styleId: style.id, standardPrice: '10.00' };
        expect((await request(app).post('/skus').set(as(managerId)).send({ ...base, styleId: randomUUID(), skuCode: nextCode('K'), size: 'S', color: 'Red' })).status).toBe(404);
        expect((await request(app).post('/skus').set(as(managerId)).send({ ...base, styleId: 'abc', skuCode: nextCode('K'), size: 'S', color: 'Red' })).status).toBe(400);
        expect((await request(app).post('/skus').set(as(managerId)).send({ ...base, skuCode: sku.skuCode.toLowerCase(), size: 'S', color: 'Red' })).status).toBe(409);
        expect((await request(app).post('/skus').set(as(managerId)).send({ ...base, skuCode: nextCode('K'), size: ' m ', color: 'RED' })).status).toBe(409);
        for (const body of [{}, { skuCode: nextCode('K') }, { skuCode: nextCode('K'), size: 'S' }, { skuCode: nextCode('K'), color: 'Red' }, { skuCode: 'bad code', size: 'S', color: 'Red' }, { skuCode: nextCode('K'), size: 'S'.repeat(21), color: 'Red' }, { skuCode: nextCode('K'), size: 'S', color: 'C'.repeat(41) }]) {
            expect((await request(app).post('/skus').set(as(managerId)).send({ ...base, ...body })).status).toBe(400);
        }
        await request(app).patch(`/styles/${style.id}`).set(as(managerId)).send({ isActive: false });
        expect((await request(app).post('/skus').set(as(managerId)).send({ ...base, skuCode: nextCode('K'), size: 'XL', color: 'Red' })).status).toBe(409);
    });

    it('two requests creating the same sku at once: one wins, the other gets a clean 409 (never a 500)', async () => {
        const style = await makeStyle();
        const code = nextCode('K');
        const send = () => request(app).post('/skus').set(as(managerId)).send({ styleId: style.id, skuCode: code, size: 'M', color: 'Red', standardPrice: '5.00' });
        const results = await Promise.all([send(), send(), send()]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    });

    it('lists with the style name, searches by code, color or style name, filters by style, and pages', async () => {
        const style = await makeStyle({ name: `Searchable Jacket ${stamp}` });
        const other = await makeStyle({ name: 'Something Else' });
        const red = await makeSku(style.id, { size: 'S', color: 'Crimson' });
        const blue = await makeSku(style.id, { size: 'M', color: 'Navy' });
        const foreign = await makeSku(other.id);

        const byStyleName = await request(app).get(`/skus?search=jacket ${stamp}`).set(as(employeeId));
        expect(byStyleName.body.map((s: { id: string }) => s.id).sort()).toEqual([red.id, blue.id].sort());
        expect(byStyleName.body[0].style).toMatchObject({ id: style.id, code: style.code, name: `Searchable Jacket ${stamp}` });
        const byColor = await request(app).get(`/skus?search=crimson&styleId=${style.id}`).set(as(employeeId));
        expect(byColor.body.map((s: { id: string }) => s.id)).toEqual([red.id]);
        const byCode = await request(app).get(`/skus?search=${foreign.skuCode.toLowerCase()}`).set(as(employeeId));
        expect(byCode.body.map((s: { id: string }) => s.id)).toEqual([foreign.id]);
        const page = await request(app).get(`/skus?styleId=${style.id}&limit=1&offset=1`).set(as(employeeId));
        expect(page.body).toHaveLength(1);
        expect((await request(app).get('/skus?styleId=abc').set(as(employeeId))).status).toBe(400);
        expect((await request(app).get('/skus?limit=500').set(as(employeeId))).status).toBe(400);
    });

    it('shows the detail: style and barcodes; unknown or malformed id is 404', async () => {
        const style = await makeStyle();
        const sku = await makeSku(style.id);
        await request(app).post(`/skus/${sku.id}/barcodes`).set(as(managerId)).send({ code: `${prefix}-BC-DETAIL` });
        const res = await request(app).get(`/skus/${sku.id}`).set(as(employeeId));
        expect(res.status).toBe(200);
        expect(res.body.style.id).toBe(style.id);
        expect(res.body.barcodes.map((b: { code: string }) => b.code)).toEqual([`${prefix}-BC-DETAIL`]);
        expect((await request(app).get(`/skus/${randomUUID()}`).set(as(employeeId))).status).toBe(404);
        expect((await request(app).get('/skus/abc').set(as(employeeId))).status).toBe(404);
    });

    it('updates size, color and the active flag only; code, currency and price are not changed here', async () => {
        const style = await makeStyle();
        const sku = await makeSku(style.id, { size: 'M', color: 'Red' });
        const other = await makeSku(style.id, { size: 'L', color: 'Red' });
        const res = await request(app).patch(`/skus/${sku.id}`).set(as(managerId)).send({ size: 'XL', color: 'Green', isActive: false, skuCode: 'HACK', standardPrice: '1.00', currency: 'EUR' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ size: 'XL', color: 'Green', isActive: false, skuCode: sku.skuCode, standardPrice: '25.00', currency: 'USD' });
        // moving onto another sku's variant is refused, and nothing changes
        expect((await request(app).patch(`/skus/${sku.id}`).set(as(managerId)).send({ size: 'l', color: ' RED ' })).status).toBe(409);
        expect((await request(app).get(`/skus/${sku.id}`).set(as(managerId))).body.size).toBe('XL');
        expect((await request(app).patch(`/skus/${other.id}`).set(as(managerId)).send({ isActive: 'no' })).status).toBe(400);
        expect((await request(app).patch(`/skus/${other.id}`).set(as(managerId)).send({ size: '' })).status).toBe(400);
        expect((await request(app).patch(`/skus/${randomUUID()}`).set(as(managerId)).send({ size: 'S' })).status).toBe(404);
        expect((await request(app).patch('/skus/abc').set(as(managerId)).send({ size: 'S' })).status).toBe(404);
    });
});

describe('prices', () => {
    it('changes the price, keeps the history newest first, and ignores a repeat of the same price', async () => {
        const style = await makeStyle();
        const sku = await makeSku(style.id, { standardPrice: '25.00' });

        const changed = await request(app).put(`/skus/${sku.id}/price`).set(as(managerId)).send({ price: '30.5' });
        expect(changed.status).toBe(200);
        expect(changed.body.standardPrice).toBe('30.50');
        const again = await request(app).put(`/skus/${sku.id}/price`).set(as(adminId)).send({ price: 30.5 });
        expect(again.status).toBe(200);
        await request(app).put(`/skus/${sku.id}/price`).set(as(adminId)).send({ price: '28' });

        const history = (await request(app).get(`/skus/${sku.id}/price-history`).set(as(managerId))).body;
        expect(history.map((h: { oldPrice: string | null; newPrice: string }) => [h.oldPrice, h.newPrice])).toEqual([['30.50', '28.00'], ['25.00', '30.50'], [null, '25.00']]);
        expect(history[0].changedBy).toBe(adminId);
        expect(history[1].changedBy).toBe(managerId);
        expect((await request(app).get(`/skus/${sku.id}`).set(as(employeeId))).body.standardPrice).toBe('28.00');
        const limited = await request(app).get(`/skus/${sku.id}/price-history?limit=1`).set(as(managerId));
        expect(limited.body).toHaveLength(1);
        expect((await request(app).get(`/skus/${sku.id}/price-history?limit=0`).set(as(managerId))).status).toBe(400);
    });

    it('refuses bad prices and unknown skus', async () => {
        const style = await makeStyle();
        const sku = await makeSku(style.id);
        for (const price of ['abc', -5, '1.999', null, undefined, '']) {
            expect((await request(app).put(`/skus/${sku.id}/price`).set(as(managerId)).send({ price })).status).toBe(400);
        }
        expect((await request(app).put(`/skus/${sku.id}/price`).set(as(managerId))).status).toBe(400);
        expect((await request(app).put(`/skus/${randomUUID()}/price`).set(as(managerId)).send({ price: '5' })).status).toBe(404);
        expect((await request(app).put('/skus/abc/price').set(as(managerId)).send({ price: '5' })).status).toBe(404);
        expect((await request(app).get(`/skus/${randomUUID()}/price-history`).set(as(managerId))).status).toBe(404);
        expect((await request(app).get(`/skus/${sku.id}`).set(as(managerId))).body.standardPrice).toBe('25.00');   // nothing changed
    });

    it('two price changes at once never corrupt the history: each "old price" is the price before it', async () => {
        const style = await makeStyle();
        const sku = await makeSku(style.id, { standardPrice: '10.00' });
        const results = await Promise.all([
            request(app).put(`/skus/${sku.id}/price`).set(as(managerId)).send({ price: '11.00' }),
            request(app).put(`/skus/${sku.id}/price`).set(as(adminId)).send({ price: '12.00' }),
        ]);
        expect(results.map((r) => r.status)).toEqual([200, 200]);

        const rows = await prisma.skuPriceHistory.findMany({ where: { skuId: sku.id, NOT: { oldPrice: null } } });
        expect(rows).toHaveLength(2);
        const [first, second] = rows.find((r) => r.oldPrice?.toFixed(2) === '10.00') ? [rows.find((r) => r.oldPrice?.toFixed(2) === '10.00')!, rows.find((r) => r.oldPrice?.toFixed(2) !== '10.00')!] : [rows[1], rows[0]];
        expect(first.oldPrice?.toFixed(2)).toBe('10.00');
        expect(second.oldPrice?.toFixed(2)).toBe(first.newPrice.toFixed(2));                       // a clean chain 10 -> X -> Y
        const final = await prisma.sku.findUnique({ where: { id: sku.id } });
        expect(final?.standardPrice.toFixed(2)).toBe(second.newPrice.toFixed(2));
    });
});

describe('barcodes and the scanner lookup', () => {
    it('adds barcodes, finds the sku by barcode or by sku code, and stops finding it after the barcode is removed', async () => {
        const style = await makeStyle({ name: 'Scanned Tee' });
        const sku = await makeSku(style.id);
        const code = `${prefix}-5901234123457`;
        const added = await request(app).post(`/skus/${sku.id}/barcodes`).set(as(managerId)).send({ code: ` ${code} ` });
        expect(added.status).toBe(201);
        expect(added.body).toMatchObject({ skuId: sku.id, code });

        const byBarcode = await request(app).get(`/skus/lookup?code=${code}`).set(as(employeeId));
        expect(byBarcode.status).toBe(200);
        expect(byBarcode.body).toMatchObject({ id: sku.id, standardPrice: '25.00', style: { id: style.id, name: 'Scanned Tee' } });
        expect(byBarcode.body.barcodes).toHaveLength(1);
        const bySkuCode = await request(app).get(`/skus/lookup?code=${sku.skuCode.toLowerCase()}`).set(as(employeeId));
        expect(bySkuCode.body.id).toBe(sku.id);

        expect((await request(app).delete(`/barcodes/${added.body.id}`).set(as(managerId))).status).toBe(204);
        expect((await request(app).get(`/skus/lookup?code=${code}`).set(as(employeeId))).status).toBe(404);
        expect((await request(app).delete(`/barcodes/${added.body.id}`).set(as(managerId))).status).toBe(404);   // already gone
    });

    it('lookup: unknown code is 404, a missing or empty code is 400', async () => {
        expect((await request(app).get('/skus/lookup?code=000-not-there').set(as(employeeId))).status).toBe(404);
        expect((await request(app).get('/skus/lookup?code=%20%20').set(as(employeeId))).status).toBe(400);
        expect((await request(app).get('/skus/lookup').set(as(employeeId))).status).toBe(400);
        expect((await request(app).get('/skus/lookup?code=has space&code=two').set(as(employeeId))).status).toBe(400);
    });

    it('a barcode belongs to ONE sku in the whole catalog: a second sku cannot take it (409)', async () => {
        const style = await makeStyle();
        const a = await makeSku(style.id, { size: 'S' });
        const b = await makeSku(style.id, { size: 'L' });
        const code = `${prefix}-UNIQUE-1`;
        expect((await request(app).post(`/skus/${a.id}/barcodes`).set(as(managerId)).send({ code })).status).toBe(201);
        expect((await request(app).post(`/skus/${b.id}/barcodes`).set(as(managerId)).send({ code })).status).toBe(409);
        expect((await request(app).post(`/skus/${a.id}/barcodes`).set(as(managerId)).send({ code })).status).toBe(409);
        const sends = await Promise.all([1, 2, 3].map(() => request(app).post(`/skus/${b.id}/barcodes`).set(as(managerId)).send({ code: `${prefix}-RACE` })));
        expect(sends.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    });

    it('refuses bad barcodes and unknown skus', async () => {
        const style = await makeStyle();
        const sku = await makeSku(style.id);
        for (const body of [{}, { code: '' }, { code: '   ' }, { code: 'has space' }, { code: 'ü' }, { code: 'x'.repeat(65) }, { code: 123 }]) {
            expect((await request(app).post(`/skus/${sku.id}/barcodes`).set(as(managerId)).send(body)).status).toBe(400);
        }
        expect((await request(app).post(`/skus/${randomUUID()}/barcodes`).set(as(managerId)).send({ code: '1234' })).status).toBe(404);
        expect((await request(app).post('/skus/abc/barcodes').set(as(managerId)).send({ code: '1234' })).status).toBe(404);
        expect((await request(app).delete('/barcodes/abc').set(as(managerId))).status).toBe(404);
        expect((await request(app).delete(`/barcodes/${randomUUID()}`).set(as(managerId))).status).toBe(404);
    });
});
