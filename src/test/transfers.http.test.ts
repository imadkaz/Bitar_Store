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

// Transfers write stock movements and audit events: rows that can NEVER be deleted (on purpose).
// So they run only on a database you can throw away. Set TEST_DB_DISPOSABLE=1 to run them.
const disposable = process.env.TEST_DB_DISPOSABLE === '1';

const stamp = Date.now();
const tokens = new JwtTokenService(process.env.JWT_SECRET!);
const as = (id: string) => ({ Authorization: `Bearer ${tokens.sign(id)}` });
const key = () => `tr-${randomUUID()}`;

let adminId = '', hamraManagerId = '', hamraStaffId = '', tripoliManagerId = '';
let warehouseId = '', hamraId = '', tripoliId = '', styleId = '';
let counter = 0;

const newSku = async (price = '45.00') => {
    const res = await request(app).post('/skus').set(as(adminId)).send({ styleId, skuCode: `TR${stamp}-${++counter}`, size: `S${counter}`, color: 'Blue', standardPrice: price });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
};
const open = async (skuId: string, quantities: [string, number][]) => {
    for (const [branchId, quantity] of quantities) {
        const res = await request(app).post('/stock/opening').set(as(adminId)).set('Idempotency-Key', key()).send({ branchId, lines: [{ skuId, quantity }] });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
};
const qty = async (branchId: string, skuId: string, bucket: 'sellable' | 'in_transit' | 'non_sellable') => (await prisma.stockBalance.findFirst({ where: { branchId, skuId, bucket } }))?.quantity ?? 0;
const draft = (userId: string, from: string, to: string, lines: { skuId: string; quantity: number }[], extra: object = {}) =>
    request(app).post('/transfers').set(as(userId)).set('Idempotency-Key', key()).send({ sourceBranchId: from, destinationBranchId: to, lines, ...extra });
const dispatch = (userId: string, id: string, body: object = {}, k = key()) => request(app).post(`/transfers/${id}/dispatch`).set(as(userId)).set('Idempotency-Key', k).send(body);
const receive = (userId: string, id: string, lines: object[], k = key()) => request(app).post(`/transfers/${id}/receive`).set(as(userId)).set('Idempotency-Key', k).send({ lines });
const resolve = (userId: string, id: string, reason: string, k = key()) => request(app).post(`/transfers/${id}/resolve`).set(as(userId)).set('Idempotency-Key', k).send({ reason });
const sell = (userId: string, branchId: string, skuId: string, quantity: number) =>
    request(app).post('/sales').set(as(userId)).set('Idempotency-Key', key()).send({ branchId, lines: [{ skuId, quantity }], payments: [{ method: 'cash', amount: (45 * quantity).toFixed(2) }] });

describe.skipIf(!disposable)('transfers (real database)', () => {
    beforeAll(async () => {
        await waitForDatabase(prisma);
        const repo = new UserRepository(prisma);
        const make = async (tag: string, role: UserRole, by: string | null) => (await createUserWithPassword(repo, { email: `${tag}-${stamp}@bitar.test`, password: 'Password#123', fullName: `Test ${tag}`, role }, by)).getId();
        adminId = await make('tadmin', UserRole.ADMIN, null);
        hamraManagerId = await make('thm', UserRole.MANAGER, adminId);
        hamraStaffId = await make('ths', UserRole.EMPLOYEE, adminId);
        tripoliManagerId = await make('ttm', UserRole.MANAGER, adminId);
        hamraId = (await request(app).post('/branches').set(as(adminId)).send({ code: `TRH-${stamp}`, name: 'Hamra (transfer test)' })).body.id;
        tripoliId = (await request(app).post('/branches').set(as(adminId)).send({ code: `TRT-${stamp}`, name: 'Tripoli (transfer test)' })).body.id;
        for (const [user, branch] of [[hamraManagerId, hamraId], [hamraStaffId, hamraId], [tripoliManagerId, tripoliId]]) expect((await request(app).put(`/users/${user}/branches/${branch}`).set(as(adminId))).status).toBe(204);
        // an employee receives only when it is GRANTED (BL-03: confirming an arrival is a manager's act)
        expect((await request(app).put(`/users/${hamraStaffId}/permissions`).set(as(adminId)).send({ permissions: { 'transfers.receive': true } })).status).toBeLessThan(300);
        const all = await request(app).get('/branches').set(as(adminId));
        warehouseId = all.body.find((b: { kind: string }) => b.kind === 'warehouse')?.id;
        if (!warehouseId) warehouseId = (await request(app).post('/branches').set(as(adminId)).send({ code: `TRW-${stamp}`, name: 'Main Warehouse (test)', kind: 'warehouse' })).body.id;
        styleId = (await request(app).post('/styles').set(as(adminId)).send({ code: `TRS${stamp}`, name: 'Transfer Test Dress' })).body.id;
    }, 120_000);

    describe('a whole transfer, with the real numbers', () => {
        it('warehouse to branch: create, dispatch, receive (good and damaged), confirm the loss; every number on both sides is right', async () => {
            const sku = await newSku();
            await open(sku, [[warehouseId, 50], [hamraId, 10]]);

            const created = await draft(adminId, warehouseId, hamraId, [{ skuId: sku, quantity: 10 }], { note: 'weekly supply' });
            expect(created.status, JSON.stringify(created.body)).toBe(201);
            expect(created.body).toMatchObject({ status: 'draft', from: { id: warehouseId, kind: 'warehouse' }, to: { id: hamraId }, note: 'weekly supply', totals: { requested: 10, dispatched: 0 } });
            expect(created.body.reference).toMatch(/^T-\d{8}$/);
            const id = created.body.id;
            expect(await qty(warehouseId, sku, 'sellable')).toBe(50);                       // a draft moves nothing

            const sent = await dispatch(adminId, id);
            expect(sent.status, JSON.stringify(sent.body)).toBe(200);
            expect(sent.body).toMatchObject({ status: 'dispatched', totals: { dispatched: 10, onTheRoad: 10 } });
            expect(sent.body.dispatchedBy.id).toBe(adminId);
            expect([await qty(warehouseId, sku, 'sellable'), await qty(hamraId, sku, 'in_transit'), await qty(hamraId, sku, 'sellable')]).toEqual([40, 10, 10]);

            const overview = await request(app).get(`/stock/overview?search=TR${stamp}-${counter}`).set(as(adminId));
            const here = overview.body.items[0].locations.find((l: { branchId: string }) => l.branchId === hamraId);
            expect(here).toMatchObject({ sellable: 10, inTransit: 10 });                        // the admin sees what is on the road

            const got = await receive(hamraStaffId, id, [{ skuId: sku, accepted: 8, damaged: 1 }]);
            expect(got.status, JSON.stringify(got.body)).toBe(200);
            expect(got.body).toMatchObject({ status: 'partially_received', totals: { received: 9, onTheRoad: 1 } });
            expect([await qty(hamraId, sku, 'sellable'), await qty(hamraId, sku, 'non_sellable'), await qty(hamraId, sku, 'in_transit')]).toEqual([18, 1, 1]);

            const closed = await resolve(hamraManagerId, id, 'One piece lost by the courier');
            expect(closed.status, JSON.stringify(closed.body)).toBe(200);
            expect(closed.body).toMatchObject({ status: 'closed', totals: { received: 9, lost: 1, onTheRoad: 0 } });
            expect([await qty(hamraId, sku, 'in_transit'), await qty(warehouseId, sku, 'sellable') + await qty(hamraId, sku, 'sellable') + await qty(hamraId, sku, 'non_sellable')]).toEqual([0, 59]);      // 60 - 1 lost

            const ledger = await prisma.stockMovement.findMany({ where: { transferId: id }, orderBy: { occurredAt: 'asc' } });
            expect(ledger.map((m) => m.movementType)).toEqual(['transfer_dispatch', 'transfer_dispatch', 'transfer_receipt', 'transfer_receipt', 'transfer_receipt', 'transfer_resolution']);
            expect(ledger.find((m) => m.movementType === 'transfer_resolution')).toMatchObject({ quantityDelta: -1, bucket: 'in_transit', reason: 'One piece lost by the courier' });

            const audit = await request(app).get(`/audit-events?entityType=transfer&entityId=${id}`).set(as(adminId));
            expect(audit.body.map((e: { action: string }) => e.action).reverse()).toEqual(['transfer.create', 'transfer.dispatch', 'transfer.receive', 'transfer.resolve']);
            expect(audit.body[0].by).toMatchObject({ id: hamraManagerId });
        });

        it('a branch sends back to the warehouse, and what arrives all good is "received" (not closed)', async () => {
            const sku = await newSku();
            await open(sku, [[hamraId, 6]]);
            const t = await draft(hamraManagerId, hamraId, warehouseId, [{ skuId: sku, quantity: 4 }]);
            expect(t.status).toBe(201);
            expect((await dispatch(hamraManagerId, t.body.id)).body.status).toBe('dispatched');
            expect((await receive(adminId, t.body.id, [{ skuId: sku, accepted: 4 }])).body.status).toBe('received');
            expect([await qty(hamraId, sku, 'sellable'), await qty(warehouseId, sku, 'sellable')]).toEqual([2, 4]);
        });

        it('the books balance: the stock audit view is empty for these places and nothing is negative', async () => {
            const diffs = await prisma.$queryRaw<{ sku_id: string }[]>`SELECT sku_id FROM v_stock_reconciliation_diffs WHERE branch_id IN (${hamraId}::uuid, ${tripoliId}::uuid, ${warehouseId}::uuid)`;
            expect(diffs).toEqual([]);
            expect(await prisma.stockBalance.count({ where: { branchId: { in: [hamraId, tripoliId, warehouseId] }, quantity: { lt: 0 } } })).toBe(0);
        });
    });

    describe('what is on the road counts for the replenishment', () => {
        it('a branch below its minimum stops being asked for more once the pieces are on their way', async () => {
            const sku = await newSku();
            await open(sku, [[warehouseId, 30], [hamraId, 10]]);
            await request(app).put('/reorder-levels').set(as(adminId)).send({ branchId: hamraId, skuId: sku, minQuantity: 12, targetQuantity: 20 });
            const find = async () => (await request(app).get(`/replenishment/suggestions?branchId=${hamraId}`).set(as(adminId))).body.suggestions.find((s: { sku: { id: string } }) => s.sku.id === sku);

            expect(await find()).toMatchObject({ sellable: 10, inTransit: 0, suggested: 10, fillable: 10 });
            const t = await draft(adminId, warehouseId, hamraId, [{ skuId: sku, quantity: 10 }]);
            await dispatch(adminId, t.body.id);
            expect(await find()).toBeUndefined();                                                  // 10 here + 10 coming = 20: nothing more to send
            const got = await receive(hamraManagerId, t.body.id, [{ skuId: sku, accepted: 10 }]);
            expect(got.body.status).toBe('received');
            expect(await find()).toBeUndefined();                                                  // now it is on the shelf: 20
        });
    });

    describe('who can do what', () => {
        it('an employee may receive but not prepare, send, resolve or cancel; a stranger sees nothing; the wrong side is refused', async () => {
            const sku = await newSku();
            await open(sku, [[warehouseId, 20]]);
            expect((await draft(hamraStaffId, hamraId, warehouseId, [{ skuId: sku, quantity: 1 }])).status).toBe(403);          // an employee does not send
            expect((await draft(tripoliManagerId, warehouseId, hamraId, [{ skuId: sku, quantity: 1 }])).status).toBe(403);      // asking for a place that is not yours
            expect((await draft(hamraManagerId, tripoliId, hamraId, [{ skuId: sku, quantity: 1 }])).status).toBe(403);          // neither place is theirs to send from, and the sender is not the warehouse
            const t = (await draft(adminId, warehouseId, hamraId, [{ skuId: sku, quantity: 5 }])).body.id;

            expect((await dispatch(hamraStaffId, t)).status).toBe(403);
            expect((await dispatch(hamraManagerId, t)).status).toBe(403);                                // the receiver cannot send
            expect((await dispatch(tripoliManagerId, t)).status).toBe(404);                              // a stranger does not even see it
            expect((await request(app).get(`/transfers/${t}`).set(as(tripoliManagerId))).status).toBe(404);
            expect((await request(app).get(`/transfers/${t}`).set(as(hamraStaffId))).status).toBe(200);
            expect((await request(app).post(`/transfers/${t}/cancel`).set(as(hamraManagerId))).status).toBe(403);

            await dispatch(adminId, t);
            expect((await receive(tripoliManagerId, t, [{ skuId: sku, accepted: 1 }])).status).toBe(404);
            expect((await receive(adminId, t, [{ skuId: sku, accepted: 1 }])).status).toBe(200);          // the admin reaches every place
            expect((await resolve(hamraStaffId, t, 'lost in the van')).status).toBe(403);
            expect((await request(app).post('/transfers').send({})).status).toBe(401);
            expect((await request(app).get('/transfers/abc').set(as(adminId))).status).toBe(404);
        });

        it('lists: the admin all, a manager the ones touching their places; filters, paging and the total', async () => {
            const sku = await newSku();
            await open(sku, [[warehouseId, 10]]);
            const toHamra = (await draft(adminId, warehouseId, hamraId, [{ skuId: sku, quantity: 1 }])).body;
            const toTripoli = (await draft(adminId, warehouseId, tripoliId, [{ skuId: sku, quantity: 1 }])).body;
            const hamraList = await request(app).get('/transfers?limit=200').set(as(hamraManagerId));
            const ids = hamraList.body.map((t: { id: string }) => t.id);
            expect(ids).toContain(toHamra.id);
            expect(ids).not.toContain(toTripoli.id);
            expect(hamraList.body.every((t: { from: { id: string }; to: { id: string } }) => t.from.id === hamraId || t.to.id === hamraId)).toBe(true);
            const forTripoli = await request(app).get(`/transfers?branchId=${tripoliId}&status=draft&limit=1`).set(as(adminId));
            expect(forTripoli.body).toHaveLength(1);
            expect(Number(forTripoli.headers['x-total-count'])).toBeGreaterThanOrEqual(1);
            expect((await request(app).get(`/transfers?branchId=${tripoliId}`).set(as(hamraManagerId))).status).toBe(403);
            for (const q of ['status=lost', 'branchId=abc', 'limit=0', 'offset=-1']) expect((await request(app).get(`/transfers?${q}`).set(as(adminId))).status, q).toBe(400);
        });

        it('every bad body is a 400, and a draft can be cancelled but not a sent transfer', async () => {
            const sku = await newSku();
            await open(sku, [[warehouseId, 10]]);
            const send = (body: object) => request(app).post('/transfers').set(as(adminId)).set('Idempotency-Key', key()).send(body);
            for (const body of [{}, { sourceBranchId: warehouseId }, { sourceBranchId: warehouseId, destinationBranchId: warehouseId, lines: [{ skuId: sku, quantity: 1 }] }, { sourceBranchId: warehouseId, destinationBranchId: hamraId, lines: [] },
                { sourceBranchId: warehouseId, destinationBranchId: hamraId, lines: [{ skuId: sku, quantity: 0 }] }, { sourceBranchId: warehouseId, destinationBranchId: hamraId, lines: [{ skuId: sku, quantity: 1.5 }] },
                { sourceBranchId: warehouseId, destinationBranchId: hamraId, lines: [{ skuId: sku, quantity: 1 }, { skuId: sku, quantity: 2 }] }, { sourceBranchId: 'abc', destinationBranchId: hamraId, lines: [{ skuId: sku, quantity: 1 }] }]) {
                expect((await send(body)).status, JSON.stringify(body)).toBe(400);
            }
            expect((await send({ sourceBranchId: warehouseId, destinationBranchId: randomUUID(), lines: [{ skuId: sku, quantity: 1 }] })).status).toBe(404);
            expect((await send({ sourceBranchId: warehouseId, destinationBranchId: hamraId, lines: [{ skuId: randomUUID(), quantity: 1 }] })).status).toBe(404);
            expect((await request(app).post('/transfers').set(as(adminId)).send({ sourceBranchId: warehouseId, destinationBranchId: hamraId, lines: [{ skuId: sku, quantity: 1 }] })).status).toBe(400);       // no Idempotency-Key

            const t = (await draft(adminId, warehouseId, hamraId, [{ skuId: sku, quantity: 2 }])).body.id;
            expect((await request(app).post(`/transfers/${t}/cancel`).set(as(adminId))).body.status).toBe('cancelled');
            expect((await request(app).post(`/transfers/${t}/cancel`).set(as(adminId))).body.status).toBe('cancelled');          // asking again changes nothing
            expect((await dispatch(adminId, t)).status).toBe(409);
            const sent = (await draft(adminId, warehouseId, hamraId, [{ skuId: sku, quantity: 2 }])).body.id;
            await dispatch(adminId, sent);
            expect((await request(app).post(`/transfers/${sent}/cancel`).set(as(adminId))).status).toBe(409);
            for (const lines of [[], [{ skuId: sku, accepted: 0 }], [{ skuId: sku, accepted: 3 }], [{ skuId: randomUUID(), accepted: 1 }]]) {
                expect((await receive(adminId, sent, lines)).status, JSON.stringify(lines)).toBeGreaterThanOrEqual(400);
            }
            expect((await resolve(adminId, sent, 'x')).status).toBe(400);
            expect(await qty(hamraId, sku, 'sellable')).toBe(0);                                          // none of the bad requests moved anything
        });
    });

    describe('a branch asks the warehouse to restock it', () => {
        it('the employee asks, the warehouse sends, the employee receives; the one who asked can cancel but not send', async () => {
            const sku = await newSku();
            await open(sku, [[warehouseId, 20]]);
            const asked = await draft(hamraStaffId, warehouseId, hamraId, [{ skuId: sku, quantity: 5 }], { note: 'running low' });
            expect(asked.status, JSON.stringify(asked.body)).toBe(201);
            expect(asked.body).toMatchObject({ status: 'draft', requestedBy: { id: hamraStaffId }, from: { kind: 'warehouse' }, to: { id: hamraId } });
            expect(await qty(warehouseId, sku, 'sellable')).toBe(20);                                  // asking moves nothing
            expect((await dispatch(hamraStaffId, asked.body.id)).status).toBe(403);                   // the branch cannot send from the warehouse
            expect((await dispatch(hamraManagerId, asked.body.id)).status).toBe(403);
            expect((await dispatch(adminId, asked.body.id)).status).toBe(200);                        // the warehouse can
            expect((await receive(hamraStaffId, asked.body.id, [{ skuId: sku, accepted: 5 }])).body.status).toBe('received');
            expect(await qty(hamraId, sku, 'sellable')).toBe(5);

            const second = (await draft(hamraStaffId, warehouseId, hamraId, [{ skuId: sku, quantity: 1 }])).body.id;
            expect((await request(app).post(`/transfers/${second}/cancel`).set(as(hamraStaffId))).body.status).toBe('cancelled');
        });
    });

    describe('retries and races', () => {
        it('the same request again (a retry after a bad connection) is done once and answers the same', async () => {
            const sku = await newSku();
            await open(sku, [[warehouseId, 20]]);
            const t = (await draft(adminId, warehouseId, hamraId, [{ skuId: sku, quantity: 6 }])).body.id;
            const k = key();
            const first = await dispatch(adminId, t, {}, k);
            const again = await dispatch(adminId, t, {}, k);
            expect(first.status).toBe(200);
            expect(again.status).toBe(200);
            expect(again.headers['idempotent-replay']).toBe('true');
            expect(first.headers['idempotent-replay']).toBeUndefined();
            expect(await qty(warehouseId, sku, 'sellable')).toBe(14);                                      // sent ONCE
            expect((await dispatch(adminId, t, { lines: [{ skuId: sku, quantity: 1 }] }, k)).status).toBe(409);       // the same key for a different request

            const rk = key();
            const r1 = await receive(hamraManagerId, t, [{ skuId: sku, accepted: 4 }], rk);
            const r2 = await receive(hamraManagerId, t, [{ skuId: sku, accepted: 4 }], rk);
            expect([r1.status, r2.status, r2.headers['idempotent-replay']]).toEqual([200, 200, 'true']);
            expect(await qty(hamraId, sku, 'sellable')).toBe(4);                                           // received ONCE
        });

        it('not enough at the sender: 409 with the items, nothing moves, and the shortage is recorded', async () => {
            const sku = await newSku();
            await open(sku, [[warehouseId, 3]]);
            const t = (await draft(adminId, warehouseId, hamraId, [{ skuId: sku, quantity: 5 }])).body.id;
            const res = await dispatch(adminId, t);
            expect(res.status).toBe(409);
            expect(res.body.details).toEqual([{ skuId: sku, skuCode: expect.stringMatching(/^TR/), requested: 5, available: 3 }]);
            expect([await qty(warehouseId, sku, 'sellable'), await qty(hamraId, sku, 'in_transit')]).toEqual([3, 0]);
            expect((await request(app).get(`/transfers/${t}`).set(as(adminId))).body.status).toBe('draft');
            expect(await prisma.stockAlert.count({ where: { skuId: sku, branchId: warehouseId } })).toBe(1);
        });

        it('two people dispatch the same transfer at the same moment: ONE wins, the pieces leave once', async () => {
            const sku = await newSku();
            await open(sku, [[warehouseId, 30]]);
            const t = (await draft(adminId, warehouseId, hamraId, [{ skuId: sku, quantity: 10 }])).body.id;
            const results = await Promise.all([dispatch(adminId, t), dispatch(adminId, t), dispatch(adminId, t)]);
            const statuses = results.map((r) => r.status).sort();
            expect(statuses).toEqual([200, 409, 409]);
            expect(await qty(warehouseId, sku, 'sellable')).toBe(20);
            expect(await qty(hamraId, sku, 'in_transit')).toBe(10);
            expect(await prisma.stockMovement.count({ where: { transferId: t } })).toBe(2);
        });

        it('the same request sent 4 times at once is done once', async () => {
            const sku = await newSku();
            await open(sku, [[warehouseId, 30]]);
            const t = (await draft(adminId, warehouseId, hamraId, [{ skuId: sku, quantity: 10 }])).body.id;
            const k = key();
            const results = await Promise.all([1, 2, 3, 4].map(() => dispatch(adminId, t, {}, k)));
            expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
            expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
            expect(await qty(warehouseId, sku, 'sellable')).toBe(20);
            expect(await prisma.stockMovement.count({ where: { transferId: t } })).toBe(2);
        });

        it('the whole delivery received twice at the same moment: one counts, the other is refused', async () => {
            const sku = await newSku();
            await open(sku, [[warehouseId, 30]]);
            const t = (await draft(adminId, warehouseId, hamraId, [{ skuId: sku, quantity: 10 }])).body.id;
            await dispatch(adminId, t);
            const results = await Promise.all([receive(hamraManagerId, t, [{ skuId: sku, accepted: 10 }]), receive(hamraStaffId, t, [{ skuId: sku, accepted: 10 }])]);
            expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
            expect(await qty(hamraId, sku, 'sellable')).toBe(10);
            expect(await qty(hamraId, sku, 'in_transit')).toBe(0);
        });

        it('a cashier sells while the branch sends its last pieces back: never both, never negative, the books balance', async () => {
            for (let round = 0; round < 3; round++) {
                const sku = await newSku();
                await open(sku, [[hamraId, 3]]);
                const t = (await draft(hamraManagerId, hamraId, warehouseId, [{ skuId: sku, quantity: 3 }])).body.id;
                const [sale, sent] = await Promise.all([sell(hamraStaffId, hamraId, sku, 1), dispatch(hamraManagerId, t)]);
                expect([sale.status, sent.status].filter((s) => s < 300)).toHaveLength(1);               // exactly one of them got the pieces
                expect([sale.status, sent.status].filter((s) => s === 409)).toHaveLength(1);
                const left = await qty(hamraId, sku, 'sellable');
                expect(left).toBeGreaterThanOrEqual(0);
                expect([0, 2]).toContain(left);                                                          // sale first: 2 left, transfer refused. Transfer first: 0 left, sale refused.
            }
            const diffs = await prisma.$queryRaw<{ sku_id: string }[]>`SELECT sku_id FROM v_stock_reconciliation_diffs WHERE branch_id IN (${hamraId}::uuid, ${warehouseId}::uuid)`;
            expect(diffs).toEqual([]);
        });
    });
});

// ---- added: what the destination counted is kept on the server (who, when, the note, accepted and damaged), not in a browser tab
describe.skipIf(!disposable)('the receiving record of a transfer (real database)', () => {
    let a = '', wh = '', br = '', other = '', mgr = '', emp = '', skuA = '', skuB = '';
    const k = () => `rc-${randomUUID()}`;
    const makeUser = async (tag: string, role: UserRole) => (await createUserWithPassword(new UserRepository(prisma), { email: `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@bitar.test`, password: 'Password#123', fullName: `Test ${tag}`, role }, a)).getId();
    const tk = (id: string) => ({ Authorization: `Bearer ${tokens.sign(id)}` });

    beforeAll(async () => {
        await waitForDatabase(prisma);
        a = (await createUserWithPassword(new UserRepository(prisma), { email: `rcadmin-${Date.now()}@bitar.test`, password: 'Password#123', fullName: 'Test rcadmin', role: UserRole.ADMIN }, null)).getId();
        const branches = await request(app).get('/branches').set(tk(a));
        wh = branches.body.find((b: { kind: string }) => b.kind === 'warehouse')?.id;
        if (!wh) wh = (await request(app).post('/branches').set(tk(a)).send({ code: `RCW-${Date.now()}`, name: 'Main Warehouse (receipt test)', kind: 'warehouse' })).body.id;
        await request(app).patch(`/branches/${wh}`).set(tk(a)).send({ isActive: true });
        br = (await request(app).post('/branches').set(tk(a)).send({ code: `RCB-${Date.now()}`, name: 'Receipt Branch' })).body.id;
        other = (await request(app).post('/branches').set(tk(a)).send({ code: `RCO-${Date.now()}`, name: 'Receipt Other' })).body.id;
        mgr = await makeUser('rcmgr', UserRole.MANAGER);
        emp = await makeUser('rcemp', UserRole.EMPLOYEE);
        await request(app).put(`/users/${mgr}/branches/${br}`).set(tk(a));
        await request(app).put(`/users/${emp}/branches/${br}`).set(tk(a));
        await request(app).put(`/users/${emp}/permissions`).set(tk(a)).send({ permissions: { 'transfers.receive': true } });      // granted: the receiving employee
        const styleId = (await request(app).post('/styles').set(tk(a)).send({ code: `RCS${Date.now()}`, name: 'Receipt Dress' })).body.id;
        skuA = (await request(app).post('/skus').set(tk(a)).send({ styleId, skuCode: `RC${Date.now()}-A`, size: 'S', color: 'Red', standardPrice: '10.00' })).body.id;
        skuB = (await request(app).post('/skus').set(tk(a)).send({ styleId, skuCode: `RC${Date.now()}-B`, size: 'M', color: 'Red', standardPrice: '10.00' })).body.id;
        await request(app).post('/stock/opening').set(tk(a)).set('Idempotency-Key', k()).send({ branchId: wh, lines: [{ skuId: skuA, quantity: 100 }, { skuId: skuB, quantity: 100 }] });
    }, 120_000);

    const sent = async (lines: { skuId: string; quantity: number }[]) => {
        const t = (await request(app).post('/transfers').set(tk(a)).set('Idempotency-Key', k()).send({ sourceBranchId: wh, destinationBranchId: br, lines })).body;
        expect((await request(app).post(`/transfers/${t.id}/dispatch`).set(tk(a)).set('Idempotency-Key', k())).status).toBe(200);
        return t.id as string;
    };

    it('each count is kept with who, when, the note and what was accepted and damaged; the line and the totals add the damaged up', async () => {
        const id = await sent([{ skuId: skuA, quantity: 10 }, { skuId: skuB, quantity: 6 }]);
        expect((await request(app).get(`/transfers/${id}`).set(tk(mgr))).body.receipts).toEqual([]);
        const first = await request(app).post(`/transfers/${id}/receive`).set(tk(mgr)).set('Idempotency-Key', k()).send({ lines: [{ skuId: skuA, accepted: 5, damaged: 1 }], note: '  2 cartons wet, seams checked  ' });
        expect(first.status, JSON.stringify(first.body)).toBe(200);
        const second = await request(app).post(`/transfers/${id}/receive`).set(tk(emp)).set('Idempotency-Key', k()).send({ lines: [{ skuId: skuA, accepted: 3 }, { skuId: skuB, accepted: 4, damaged: 2 }] });
        expect(second.status, JSON.stringify(second.body)).toBe(200);
        const detail = (await request(app).get(`/transfers/${id}`).set(tk(mgr))).body;
        expect(detail.receipts).toHaveLength(2);
        expect(detail.receipts[0]).toMatchObject({ note: '2 cartons wet, seams checked', by: { id: mgr, name: 'Test rcmgr' }, lines: [{ skuId: skuA, accepted: 5, damaged: 1 }] });
        expect(detail.receipts[1]).toMatchObject({ note: null, by: { id: emp } });
        expect(detail.receipts[1].lines.map((l: { skuId: string; accepted: number; damaged: number }) => [l.skuId, l.accepted, l.damaged]).sort()).toEqual([[skuA, 3, 0], [skuB, 4, 2]].sort());
        expect(new Date(detail.receipts[0].at).getTime()).toBeLessThanOrEqual(new Date(detail.receipts[1].at).getTime());
        const line = (sku: string) => detail.lines.find((l: { sku: { id: string } }) => l.sku.id === sku);
        expect(line(skuA)).toMatchObject({ requested: 10, dispatched: 10, received: 9, accepted: 8, damaged: 1, onTheRoad: 1 });
        expect(line(skuB)).toMatchObject({ received: 6, accepted: 4, damaged: 2, onTheRoad: 0 });
        expect(detail.totals).toMatchObject({ dispatched: 16, received: 15, accepted: 12, damaged: 3, onTheRoad: 1 });
        expect(first.body.receipts).toHaveLength(1);                                                       // the answer of the step itself already shows it
    });

    it('the note is optional, 1 to 500 characters of text; a retry with the same key keeps one record; the record can never be edited or deleted', async () => {
        const id = await sent([{ skuId: skuA, quantity: 4 }]);
        for (const note of [5, true, 'x'.repeat(501), 'a\u0000b']) {
            expect((await request(app).post(`/transfers/${id}/receive`).set(tk(a)).set('Idempotency-Key', k()).send({ lines: [{ skuId: skuA, accepted: 1 }], note })).status, JSON.stringify(note).slice(0, 20)).toBe(400);
        }
        expect((await request(app).get(`/transfers/${id}`).set(tk(a))).body.receipts).toEqual([]);              // a refused count leaves nothing behind
        const key = k();
        const body = { lines: [{ skuId: skuA, accepted: 2 }], note: 'Counted twice' };
        const first = await request(app).post(`/transfers/${id}/receive`).set(tk(a)).set('Idempotency-Key', key).send(body);
        const again = await request(app).post(`/transfers/${id}/receive`).set(tk(a)).set('Idempotency-Key', key).send(body);
        expect([first.status, again.status, again.headers['idempotent-replay']]).toEqual([200, 200, 'true']);
        expect((await request(app).get(`/transfers/${id}`).set(tk(a))).body.receipts).toHaveLength(1);
        expect((await request(app).post(`/transfers/${id}/receive`).set(tk(a)).set('Idempotency-Key', key).send({ ...body, note: 'Another note' })).status).toBe(409);       // same key, another request
        await expect(prisma.$executeRaw`UPDATE transfer_receipts SET note = 'edited' WHERE transfer_id = ${id}::uuid`).rejects.toThrow();
        await expect(prisma.$executeRaw`DELETE FROM transfer_receipt_lines WHERE receipt_id IN (SELECT id FROM transfer_receipts WHERE transfer_id = ${id}::uuid)`).rejects.toThrow();
    });

    it('a count that is refused (more than is on the way, someone else\'s transfer) leaves no receipt; only the receiving side may count', async () => {
        const id = await sent([{ skuId: skuA, quantity: 2 }]);
        const tooMany = await request(app).post(`/transfers/${id}/receive`).set(tk(a)).set('Idempotency-Key', k()).send({ lines: [{ skuId: skuA, accepted: 3 }], note: 'Too many' });
        expect(tooMany.status).toBe(409);
        const stranger = await makeUser('rcstranger', UserRole.MANAGER);
        await request(app).put(`/users/${stranger}/branches/${other}`).set(tk(a));
        expect((await request(app).post(`/transfers/${id}/receive`).set(tk(stranger)).set('Idempotency-Key', k()).send({ lines: [{ skuId: skuA, accepted: 1 }] })).status).toBeGreaterThanOrEqual(403);
        expect((await request(app).get(`/transfers/${id}`).set(tk(a))).body.receipts).toEqual([]);
        const listed = (await request(app).get(`/transfers?branchId=${br}`).set(tk(a))).body as { id: string; receipts: unknown[] }[];
        expect(listed.find((t) => t.id === id)?.receipts).toEqual([]);
    });
});

// ---- added: finishing the transfer (BL-03): the arrival is confirmed by a manager (an employee only when granted), and the expected arrival day
describe.skipIf(!disposable)('who confirms an arrival, and when it is expected (real database)', () => {
    let a = '', wh = '', br = '', mgr = '', plain = '', skuId = '';
    const k = () => `ea-${randomUUID()}`;
    const tk = (id: string) => ({ Authorization: `Bearer ${tokens.sign(id)}` });
    const makeUser = async (tag: string, role: UserRole) => (await createUserWithPassword(new UserRepository(prisma), { email: `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@bitar.test`, password: 'Password#123', fullName: `Test ${tag}`, role }, a)).getId();
    const day = (offset: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut' }).format(new Date(Date.now() + offset * 86_400_000));

    beforeAll(async () => {
        await waitForDatabase(prisma);
        a = (await createUserWithPassword(new UserRepository(prisma), { email: `eaadmin-${Date.now()}@bitar.test`, password: 'Password#123', fullName: 'Test eaadmin', role: UserRole.ADMIN }, null)).getId();
        const branches = await request(app).get('/branches').set(tk(a));
        wh = branches.body.find((b: { kind: string }) => b.kind === 'warehouse')?.id;
        if (!wh) wh = (await request(app).post('/branches').set(tk(a)).send({ code: `EW${String(Date.now()).slice(-8)}`, name: 'Main Warehouse (arrival test)', kind: 'warehouse' })).body.id;
        await request(app).patch(`/branches/${wh}`).set(tk(a)).send({ isActive: true });
        br = (await request(app).post('/branches').set(tk(a)).send({ code: `EB${String(Date.now()).slice(-8)}`, name: 'Arrival Branch' })).body.id;
        mgr = await makeUser('eamgr', UserRole.MANAGER);
        plain = await makeUser('eaplain', UserRole.EMPLOYEE);                     // a new employee: no grants
        for (const u of [mgr, plain]) await request(app).put(`/users/${u}/branches/${br}`).set(tk(a));
        const styleId = (await request(app).post('/styles').set(tk(a)).send({ code: `EA${String(Date.now()).slice(-8)}`, name: 'Arrival Dress' })).body.id;
        skuId = (await request(app).post('/skus').set(tk(a)).send({ styleId, skuCode: `EA${String(Date.now()).slice(-8)}-1`, size: 'M', color: 'Red', standardPrice: '10.00' })).body.id;
        await request(app).post('/stock/opening').set(tk(a)).set('Idempotency-Key', k()).send({ branchId: wh, lines: [{ skuId, quantity: 100 }] });
    }, 120_000);

    const sent = async (extra: object = {}) => {
        const t = (await request(app).post('/transfers').set(tk(a)).set('Idempotency-Key', k()).send({ sourceBranchId: wh, destinationBranchId: br, lines: [{ skuId, quantity: 4 }] })).body;
        const d = await request(app).post(`/transfers/${t.id}/dispatch`).set(tk(a)).set('Idempotency-Key', k()).send(extra);
        return { id: t.id as string, res: d };
    };

    it('a new employee cannot confirm an arrival; a manager can; an employee who was GRANTED can', async () => {
        const t = await sent();
        const refused = await request(app).post(`/transfers/${t.id}/receive`).set(tk(plain)).set('Idempotency-Key', k()).send({ lines: [{ skuId, accepted: 1 }] });
        expect(refused.status).toBe(403);
        expect(refused.body.message).toContain('transfers.receive');
        expect((await request(app).get(`/transfers/${t.id}`).set(tk(a))).body.receipts).toEqual([]);          // nothing was counted
        expect((await request(app).post(`/transfers/${t.id}/receive`).set(tk(mgr)).set('Idempotency-Key', k()).send({ lines: [{ skuId, accepted: 2 }] })).status).toBe(200);
        expect((await request(app).put(`/users/${plain}/permissions`).set(tk(a)).send({ permissions: { 'transfers.receive': true } })).status).toBeLessThan(300);
        expect((await request(app).post(`/transfers/${t.id}/receive`).set(tk(plain)).set('Idempotency-Key', k()).send({ lines: [{ skuId, accepted: 2 }] })).status).toBe(200);
        expect((await request(app).put(`/users/${plain}/permissions`).set(tk(a)).send({ permissions: { 'transfers.receive': false } })).status).toBeLessThan(300);       // taken away: it stops at once
        const t2 = await sent();
        expect((await request(app).post(`/transfers/${t2.id}/receive`).set(tk(plain)).set('Idempotency-Key', k()).send({ lines: [{ skuId, accepted: 1 }] })).status).toBe(403);
    });

    it('the day the goods are expected is given when they are sent: shown on the transfer, null when not given', async () => {
        const none = await sent();
        expect(none.res.status).toBe(200);
        expect(none.res.body.expectedAt).toBeNull();
        const tomorrow = day(1);
        const withDay = await sent({ expectedAt: tomorrow });
        expect(withDay.res.status, JSON.stringify(withDay.res.body)).toBe(200);
        expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut' }).format(new Date(withDay.res.body.expectedAt))).toBe(tomorrow);
        const read = (await request(app).get(`/transfers/${withDay.id}`).set(tk(mgr))).body;
        expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut' }).format(new Date(read.expectedAt))).toBe(tomorrow);
        const listed = (await request(app).get(`/transfers?branchId=${br}`).set(tk(a))).body as { id: string; expectedAt: string | null }[];
        expect(listed.find((x) => x.id === withDay.id)?.expectedAt).toBeTruthy();
        expect(listed.find((x) => x.id === none.id)?.expectedAt).toBeNull();
        const today = await sent({ expectedAt: day(0) });
        expect(today.res.status).toBe(200);                                           // today is allowed
    });

    it('a day in the past, too far away, or not a real date is a 400 and nothing is sent; the same key with another day is refused', async () => {
        for (const expectedAt of [day(-1), day(121), '2026-02-30', '12/11/2026', 20261112, true]) {
            const t = (await request(app).post('/transfers').set(tk(a)).set('Idempotency-Key', k()).send({ sourceBranchId: wh, destinationBranchId: br, lines: [{ skuId, quantity: 1 }] })).body;
            const d = await request(app).post(`/transfers/${t.id}/dispatch`).set(tk(a)).set('Idempotency-Key', k()).send({ expectedAt });
            expect(d.status, JSON.stringify(expectedAt)).toBe(400);
            expect((await request(app).get(`/transfers/${t.id}`).set(tk(a))).body.status).toBe('draft');
        }
        const t = (await request(app).post('/transfers').set(tk(a)).set('Idempotency-Key', k()).send({ sourceBranchId: wh, destinationBranchId: br, lines: [{ skuId, quantity: 1 }] })).body;
        const key = k();
        expect((await request(app).post(`/transfers/${t.id}/dispatch`).set(tk(a)).set('Idempotency-Key', key).send({ expectedAt: day(2) })).status).toBe(200);
        const replay = await request(app).post(`/transfers/${t.id}/dispatch`).set(tk(a)).set('Idempotency-Key', key).send({ expectedAt: day(2) });
        expect([replay.status, replay.headers['idempotent-replay']]).toEqual([200, 'true']);
        expect((await request(app).post(`/transfers/${t.id}/dispatch`).set(tk(a)).set('Idempotency-Key', key).send({ expectedAt: day(3) })).status).toBe(409);
    });
});
