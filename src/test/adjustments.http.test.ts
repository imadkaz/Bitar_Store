import 'dotenv/config';
import { vi } from 'vitest';

vi.hoisted(() => {
    process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
    process.env.AUTH_MODE = 'jwt';
});

import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../db';
import { UserRole } from '../models/User.model';
import { UserRepository } from '../repositories/UserRepository';
import { JwtTokenService } from '../services/JwtTokenService';
import { createUserWithPassword } from '../test-helpers/createUserWithPassword';
import { waitForDatabase } from '../test-helpers/waitForDatabase';
import { businessDateOf } from '../utils/businessDate';

// Adjustments write stock movements and audit events that can never be deleted: only on a database you can throw away.
const disposable = process.env.TEST_DB_DISPOSABLE === '1';

const stamp = Date.now();
const tokens = new JwtTokenService(process.env.JWT_SECRET!);
const as = (id: string) => ({ Authorization: `Bearer ${tokens.sign(id)}` });
const key = () => `adj-${randomUUID()}`;
const today = businessDateOf(new Date());

let adminId = '', managerId = '', staffId = '', tripoliManagerId = '';
let hamraId = '', tripoliId = '', warehouseId = '', styleId = '';
let counter = 0;

const newSku = async () => {
    const res = await request(app).post('/skus').set(as(adminId)).send({ styleId, skuCode: `AJ${stamp}-${++counter}`, size: `S${counter}`, color: 'Grey', standardPrice: '20.00' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
};
const open = async (skuId: string, branchId: string, quantity: number) => {
    const res = await request(app).post('/stock/opening').set(as(adminId)).set('Idempotency-Key', key()).send({ branchId, lines: [{ skuId, quantity }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
};
const qty = async (branchId: string, skuId: string, bucket = 'sellable') => (await prisma.stockBalance.findFirst({ where: { branchId, skuId, bucket } }))?.quantity ?? 0;
const adjust = (userId: string, body: object, k = key()) => request(app).post('/stock/adjustments').set(as(userId)).set('Idempotency-Key', k).send(body);
const make = async (tag: string, role: UserRole) => (await createUserWithPassword(new UserRepository(prisma), { email: `${tag}-${stamp}@bitar.test`, password: 'Password#123', fullName: `Test ${tag}`, role }, adminId)).getId();

describe.skipIf(!disposable)('stock adjustments (real database)', () => {
    beforeAll(async () => {
        await waitForDatabase(prisma);
        adminId = (await createUserWithPassword(new UserRepository(prisma), { email: `ajadmin-${stamp}@bitar.test`, password: 'Password#123', fullName: 'Test ajadmin', role: UserRole.ADMIN }, null)).getId();
        managerId = await make('ajm', UserRole.MANAGER);
        staffId = await make('ajs', UserRole.EMPLOYEE);
        tripoliManagerId = await make('ajtm', UserRole.MANAGER);
        hamraId = (await request(app).post('/branches').set(as(adminId)).send({ code: `AJH-${stamp}`, name: 'Hamra (adjustment test)' })).body.id;
        tripoliId = (await request(app).post('/branches').set(as(adminId)).send({ code: `AJT-${stamp}`, name: 'Tripoli (adjustment test)' })).body.id;
        for (const [user, branch] of [[managerId, hamraId], [staffId, hamraId], [tripoliManagerId, tripoliId]]) expect((await request(app).put(`/users/${user}/branches/${branch}`).set(as(adminId))).status).toBe(204);
        const all = await request(app).get('/branches').set(as(adminId));
        warehouseId = all.body.find((b: { kind: string }) => b.kind === 'warehouse')?.id;
        if (!warehouseId) warehouseId = (await request(app).post('/branches').set(as(adminId)).send({ code: `AJW-${stamp}`, name: 'Main Warehouse (test)', kind: 'warehouse' })).body.id;
        await request(app).patch(`/branches/${warehouseId}`).set(as(adminId)).send({ isActive: true });   // an earlier test may have left the one and only warehouse inactive
        styleId = (await request(app).post('/styles').set(as(adminId)).send({ code: `AJS${stamp}`, name: 'Adjustment Test' })).body.id;
    }, 120_000);

    describe('correcting the stock', () => {
        it('a count that does not match: the number is corrected, and the ledger and the audit log say who did it and why', async () => {
            const sku = await newSku();
            await open(sku, hamraId, 10);
            const res = await adjust(managerId, { branchId: hamraId, skuId: sku, quantityDelta: -2, reason: 'count_correction', note: 'Counted 8 on the shelf, the system had 10' });
            expect(res.status, JSON.stringify(res.body)).toBe(201);
            expect(res.body).toMatchObject({ bucket: 'sellable', quantityDelta: -2, reason: 'count_correction', balanceAfter: 8, by: { id: managerId, name: 'Test ajm' }, branch: { id: hamraId }, sku: { id: sku } });
            expect(res.body.reference).toMatch(/^A-\d{8}$/);
            expect(await qty(hamraId, sku)).toBe(8);

            const ledger = await prisma.stockMovement.findMany({ where: { adjustmentId: res.body.id } });
            expect(ledger).toHaveLength(1);
            expect(ledger[0]).toMatchObject({ movementType: 'adjustment', bucket: 'sellable', quantityDelta: -2, balanceAfter: 8, actorUserId: managerId, reason: 'count_correction' });
            const audit = await request(app).get(`/audit-events?entityType=adjustment&entityId=${res.body.id}`).set(as(adminId));
            expect(audit.body[0]).toMatchObject({ action: 'stock.adjust', by: { id: managerId }, details: { delta: -2, reason: 'count_correction', bucket: 'sellable' } });
            const moves = await request(app).get(`/stock/movements?branchId=${hamraId}&skuId=${sku}&type=adjustment`).set(as(managerId));
            expect(moves.body[0]).toMatchObject({ type: 'adjustment', quantityDelta: -2, reason: 'count_correction' });
        });

        it('"found" adds pieces, also where the sku had no stock row yet', async () => {
            const sku = await newSku();
            const res = await adjust(adminId, { branchId: tripoliId, skuId: sku, quantityDelta: 5, reason: 'found', note: 'Box found in the back room' });
            expect(res.status, JSON.stringify(res.body)).toBe(201);
            expect([res.body.balanceAfter, await qty(tripoliId, sku)]).toEqual([5, 5]);
        });

        it('"damage" takes the pieces off sale and puts them ON HOLD; written off when they are already on hold', async () => {
            const sku = await newSku();
            await open(sku, hamraId, 10);
            const damaged = await adjust(managerId, { branchId: hamraId, skuId: sku, quantityDelta: -3, reason: 'damage', note: 'Torn at the seam, 3 pieces' });
            expect(damaged.status, JSON.stringify(damaged.body)).toBe(201);
            expect([await qty(hamraId, sku), await qty(hamraId, sku, 'non_sellable')]).toEqual([7, 3]);
            expect(damaged.body.balanceAfter).toBe(7);
            expect(await prisma.stockMovement.count({ where: { adjustmentId: damaged.body.id } })).toBe(2);        // two ledger rows, one adjustment

            const writtenOff = await adjust(managerId, { branchId: hamraId, skuId: sku, bucket: 'non_sellable', quantityDelta: -3, reason: 'damage', note: 'Thrown away after inspection' });
            expect(writtenOff.status).toBe(201);
            expect([await qty(hamraId, sku), await qty(hamraId, sku, 'non_sellable')]).toEqual([7, 0]);
        });

        it('"loss" takes pieces out; each reason keeps its sign', async () => {
            const sku = await newSku();
            await open(sku, hamraId, 10);
            expect((await adjust(managerId, { branchId: hamraId, skuId: sku, quantityDelta: -1, reason: 'loss', note: 'Customer took it without paying' })).status).toBe(201);
            expect(await qty(hamraId, sku)).toBe(9);
            for (const [reason, quantityDelta] of [['found', -1], ['loss', 1], ['damage', 1]] as const) {
                expect((await adjust(managerId, { branchId: hamraId, skuId: sku, quantityDelta, reason, note: 'The wrong sign here' })).status, reason).toBe(400);
            }
            expect(await qty(hamraId, sku)).toBe(9);
            expect((await adjust(managerId, { branchId: hamraId, skuId: sku, quantityDelta: 2, reason: 'data_entry_error', note: 'Opening count was typed wrong' })).status).toBe(201);
            expect((await adjust(managerId, { branchId: hamraId, skuId: sku, quantityDelta: -1, reason: 'other', note: 'Used as a shop display piece' })).status).toBe(201);
            expect(await qty(hamraId, sku)).toBe(10);
        });

        it('an archived sku can still be corrected', async () => {
            const sku = await newSku();
            await open(sku, hamraId, 4);
            await request(app).patch(`/skus/${sku}`).set(as(adminId)).send({ isActive: false });
            expect((await adjust(managerId, { branchId: hamraId, skuId: sku, quantityDelta: -1, reason: 'count_correction', note: 'Archived but still counted' })).status).toBe(201);
        });
    });

    describe('not enough stock, bad input', () => {
        it('taking out more than there is: 409 with the item, and NOTHING changes', async () => {
            const sku = await newSku();
            await open(sku, hamraId, 3);
            const before = await prisma.adjustment.count({ where: { skuId: sku } });
            const res = await adjust(managerId, { branchId: hamraId, skuId: sku, quantityDelta: -10, reason: 'count_correction', note: 'More than there is' });
            expect(res.status).toBe(409);
            expect(res.body.details).toEqual([{ skuId: sku, skuCode: expect.stringMatching(/^AJ/), requested: 10, available: 3 }]);
            expect([await qty(hamraId, sku), await prisma.adjustment.count({ where: { skuId: sku } })]).toEqual([3, before]);
            const hold = await adjust(managerId, { branchId: hamraId, skuId: sku, bucket: 'non_sellable', quantityDelta: -1, reason: 'loss', note: 'Nothing on hold to take' });
            expect(hold.status).toBe(409);
            expect(hold.body.details[0]).toMatchObject({ requested: 1, available: 0 });
            const damage = await adjust(managerId, { branchId: hamraId, skuId: sku, quantityDelta: -5, reason: 'damage', note: 'More damaged than in stock' });
            expect(damage.status).toBe(409);
            expect([await qty(hamraId, sku), await qty(hamraId, sku, 'non_sellable')]).toEqual([3, 0]);
        });

        it('every bad body is a 400; an unknown sku or place is a 404; a reason and a note are always needed', async () => {
            const sku = await newSku();
            const ok = { branchId: hamraId, skuId: sku, quantityDelta: 1, reason: 'found', note: 'Found on the shelf' };
            for (const patch of [{ quantityDelta: 0 }, { quantityDelta: 1.5 }, { quantityDelta: '2' }, { quantityDelta: 100_001 }, { reason: 'because' }, { reason: undefined }, { note: 'abc' }, { note: '' }, { note: undefined },
                { bucket: 'in_transit' }, { bucket: 'reserved' }, { branchId: 'abc' }, { skuId: 'abc' }]) {
                expect((await adjust(managerId, { ...ok, ...patch })).status, JSON.stringify(patch)).toBe(400);
            }
            expect((await adjust(managerId, undefined as unknown as object)).status).toBe(400);
            expect((await adjust(managerId, { ...ok, skuId: randomUUID() })).status).toBe(404);
            expect((await adjust(adminId, { ...ok, branchId: randomUUID() })).status).toBe(404);
            expect((await request(app).post('/stock/adjustments').set(as(managerId)).send(ok)).status).toBe(400);       // no Idempotency-Key
            expect(await qty(hamraId, sku)).toBe(0);
        });
    });

    describe('who may adjust where', () => {
        it('an employee never; a manager at their own branches only; the admin anywhere, the warehouse included; a manager on every branch too', async () => {
            const sku = await newSku();
            await open(sku, hamraId, 5);
            await open(sku, warehouseId, 5);
            await open(sku, tripoliId, 5);
            const body = (branchId: string) => ({ branchId, skuId: sku, quantityDelta: -1, reason: 'count_correction', note: 'Checking who may adjust' });
            expect((await adjust(staffId, body(hamraId))).status).toBe(403);
            expect((await adjust(managerId, body(tripoliId))).status).toBe(403);
            expect((await adjust(managerId, body(warehouseId))).status).toBe(403);
            expect((await adjust(managerId, body(hamraId))).status).toBe(201);
            expect((await adjust(adminId, body(warehouseId))).status).toBe(201);
            expect((await adjust(adminId, body(tripoliId))).status).toBe(201);                         // the admin reaches every place
            const all = await make('ajall', UserRole.MANAGER);
            await request(app).put(`/users/${all}/branch-access`).set(as(adminId)).send({ mode: 'all' });
            expect((await adjust(all, body(hamraId))).status).toBe(201);
            expect((await adjust(all, body(warehouseId))).status).toBe(403);                           // every branch, never the warehouse
            expect((await request(app).post('/stock/adjustments').send(body(hamraId))).status).toBe(401);
        });

        it('a permission given to an employee works at once, and taken away stops it', async () => {
            const emp = await make('ajemp', UserRole.EMPLOYEE);
            await request(app).put(`/users/${emp}/branches/${hamraId}`).set(as(adminId));
            const sku = await newSku();
            await open(sku, hamraId, 3);
            const body = { branchId: hamraId, skuId: sku, quantityDelta: -1, reason: 'damage', note: 'Dropped on the floor' };
            expect((await adjust(emp, body)).status).toBe(403);
            await request(app).put(`/users/${emp}/permissions`).set(as(adminId)).send({ permissions: { 'adjustments.create': true } });
            expect((await adjust(emp, body)).status).toBe(201);
            await request(app).put(`/users/${emp}/permissions`).set(as(adminId)).send({ permissions: { 'adjustments.create': false } });
            expect((await adjust(emp, body)).status).toBe(403);
        });
    });

    describe('retries and races', () => {
        it('the same request again (a retry) is done once and answers the same; the same key for another request is refused', async () => {
            const sku = await newSku();
            await open(sku, hamraId, 10);
            const k = key();
            const body = { branchId: hamraId, skuId: sku, quantityDelta: -2, reason: 'count_correction', note: 'Counted again, 2 missing' };
            const first = await adjust(managerId, body, k);
            const again = await adjust(managerId, body, k);
            expect([first.status, again.status, again.headers['idempotent-replay'], first.headers['idempotent-replay']]).toEqual([201, 201, 'true', undefined]);
            expect(again.body.id).toBe(first.body.id);
            expect(await qty(hamraId, sku)).toBe(8);                                                    // corrected ONCE
            expect((await adjust(managerId, { ...body, quantityDelta: -1 }, k)).status).toBe(409);
        });

        it('8 corrections of -1 at the same moment on 5 pieces: exactly 5 work, 3 are refused, never below 0, the books balance', async () => {
            const sku = await newSku();
            await open(sku, hamraId, 5);
            const results = await Promise.all(Array.from({ length: 8 }, () => adjust(managerId, { branchId: hamraId, skuId: sku, quantityDelta: -1, reason: 'loss', note: 'Taken one by one' })));
            expect(results.filter((r) => r.status === 201)).toHaveLength(5);
            expect(results.filter((r) => r.status === 409)).toHaveLength(3);
            expect(await qty(hamraId, sku)).toBe(0);
            const diffs = await prisma.$queryRaw<{ sku_id: string }[]>`SELECT sku_id FROM v_stock_reconciliation_diffs WHERE sku_id = ${sku}::uuid`;
            expect(diffs).toEqual([]);
        });

        it('a sale and a correction fight for the last pieces: never both, never negative', async () => {
            for (let round = 0; round < 3; round++) {
                const sku = await newSku();
                await open(sku, hamraId, 2);
                const [sale, fix] = await Promise.all([
                    request(app).post('/sales').set(as(staffId)).set('Idempotency-Key', key()).send({ branchId: hamraId, lines: [{ skuId: sku, quantity: 2 }], payments: [{ method: 'cash', amount: '40.00' }] }),
                    adjust(managerId, { branchId: hamraId, skuId: sku, quantityDelta: -2, reason: 'loss', note: 'Both want the last two' }),
                ]);
                expect([sale.status, fix.status].filter((s) => s < 300)).toHaveLength(1);
                expect(await qty(hamraId, sku)).toBe(0);
            }
        });
    });

    describe('the history of corrections', () => {
        it('newest first, with the total; filters by sku, reason and period; scoped to the places you reach', async () => {
            const sku = await newSku();
            await open(sku, hamraId, 20);
            await open(sku, tripoliId, 20);
            for (const [user, branchId, delta, reason] of [[managerId, hamraId, -1, 'loss'], [managerId, hamraId, 2, 'found'], [tripoliManagerId, tripoliId, -3, 'count_correction']] as const) {
                expect((await adjust(user, { branchId, skuId: sku, quantityDelta: delta, reason, note: 'Test history entry' })).status).toBe(201);
            }
            const mine = await request(app).get(`/stock/adjustments?skuId=${sku}`).set(as(managerId));
            expect(mine.status).toBe(200);
            expect(mine.body).toHaveLength(2);
            expect(mine.headers['x-total-count']).toBe('2');
            expect(mine.body.every((a: { branch: { id: string } }) => a.branch.id === hamraId)).toBe(true);
            expect(mine.body.map((a: { reason: string }) => a.reason)).toEqual(['found', 'loss']);              // newest first
            const everything = await request(app).get(`/stock/adjustments?skuId=${sku}`).set(as(adminId));
            expect(everything.body).toHaveLength(3);
            expect((await request(app).get(`/stock/adjustments?skuId=${sku}&reason=loss`).set(as(adminId))).body).toHaveLength(1);
            expect((await request(app).get(`/stock/adjustments?skuId=${sku}&branchId=${tripoliId}&from=${today}&to=${today}`).set(as(adminId))).body).toHaveLength(1);
            expect((await request(app).get(`/stock/adjustments?skuId=${sku}&from=2020-01-01&to=2020-01-31`).set(as(adminId))).body).toEqual([]);
            const page = await request(app).get(`/stock/adjustments?skuId=${sku}&limit=1&offset=1`).set(as(adminId));
            expect([page.body.length, page.headers['x-total-count']]).toEqual([1, '3']);
            expect((await request(app).get(`/stock/adjustments?branchId=${tripoliId}`).set(as(managerId))).status).toBe(403);
            expect((await request(app).get('/stock/adjustments').set(as(staffId))).status).toBe(403);
            expect((await request(app).get('/stock/adjustments')).status).toBe(401);
            for (const q of ['reason=because', 'skuId=abc', 'branchId=abc', 'from=2026-02-30', 'limit=0', 'offset=-1']) expect((await request(app).get(`/stock/adjustments?${q}`).set(as(adminId))).status, q).toBe(400);
        });

        it('an adjustment can never be edited or deleted', async () => {
            const sku = await newSku();
            await open(sku, hamraId, 2);
            const res = await adjust(managerId, { branchId: hamraId, skuId: sku, quantityDelta: -1, reason: 'loss', note: 'Cannot be undone' });
            await expect(prisma.adjustment.update({ where: { id: res.body.id }, data: { note: 'Changed afterwards' } })).rejects.toThrow();
            await expect(prisma.adjustment.delete({ where: { id: res.body.id } })).rejects.toThrow();
        });
    });
});
