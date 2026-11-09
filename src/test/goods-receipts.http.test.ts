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

// Receipts, ledger rows and audit events can never be deleted: only on a database you can throw away.
const disposable = process.env.TEST_DB_DISPOSABLE === '1';

const stamp = Date.now();
const tokens = new JwtTokenService(process.env.JWT_SECRET!);
const as = (id: string) => ({ Authorization: `Bearer ${tokens.sign(id)}` });
const key = () => `gr-${randomUUID()}`;
const today = businessDateOf(new Date());

let adminId = '', warehouseManagerId = '', hamraManagerId = '', staffId = '';
let hamraId = '', warehouseId = '', styleId = '';
let counter = 0;

const newSku = async () => {
    const res = await request(app).post('/skus').set(as(adminId)).send({ styleId, skuCode: `GR${stamp}-${++counter}`, size: `S${counter}`, color: 'Grey', standardPrice: '20.00' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; skuCode: string };
};
const qty = async (branchId: string, skuId: string, bucket = 'sellable') => (await prisma.stockBalance.findFirst({ where: { branchId, skuId, bucket } }))?.quantity ?? 0;
let invoiceCounter = 0;
const receive = (userId: string, patch: Record<string, unknown> = {}, k = key()) => request(app).post('/goods-receipts').set(as(userId)).set('Idempotency-Key', k)
    .send({ supplierName: `Supplier ${stamp}`, supplierInvoiceNumber: `INV-${stamp}-${++invoiceCounter}`, invoiceDate: today, ...patch });
const make = async (tag: string, role: UserRole) => (await createUserWithPassword(new UserRepository(prisma), { email: `${tag}-${stamp}@bitar.test`, password: 'Password#123', fullName: `Test ${tag}`, role }, adminId)).getId();

describe.skipIf(!disposable)('goods receipts from a supplier (real database)', () => {
    beforeAll(async () => {
        await waitForDatabase(prisma);
        adminId = (await createUserWithPassword(new UserRepository(prisma), { email: `gradmin-${stamp}@bitar.test`, password: 'Password#123', fullName: 'Test gradmin', role: UserRole.ADMIN }, null)).getId();
        warehouseManagerId = await make('grwm', UserRole.MANAGER);
        hamraManagerId = await make('grhm', UserRole.MANAGER);
        staffId = await make('grs', UserRole.EMPLOYEE);
        hamraId = (await request(app).post('/branches').set(as(adminId)).send({ code: `GRH-${stamp}`, name: 'Hamra (receipt test)' })).body.id;
        const all = await request(app).get('/branches').set(as(adminId));
        warehouseId = all.body.find((b: { kind: string }) => b.kind === 'warehouse')?.id;
        if (!warehouseId) warehouseId = (await request(app).post('/branches').set(as(adminId)).send({ code: `GRW-${stamp}`, name: 'Main Warehouse (test)', kind: 'warehouse' })).body.id;
        await request(app).patch(`/branches/${warehouseId}`).set(as(adminId)).send({ isActive: true });   // an earlier test may have left the one and only warehouse inactive
        for (const [user, branch] of [[warehouseManagerId, warehouseId], [hamraManagerId, hamraId], [staffId, hamraId]]) expect((await request(app).put(`/users/${user}/branches/${branch}`).set(as(adminId))).status).toBe(204);
        styleId = (await request(app).post('/styles').set(as(adminId)).send({ code: `GRS${stamp}`, name: 'Receipt Test' })).body.id;
    }, 120_000);

    describe('a delivery comes in', () => {
        it('the document keeps the supplier, the invoice number and date and the price of each product; the warehouse stock grows; the ledger and the audit log say who and why', async () => {
            const a = await newSku();
            const b = await newSku();
            const res = await receive(adminId, { supplierName: '  Textile   Co ', supplierInvoiceNumber: 'INV-2041', invoiceDate: '2026-10-30', note: 'First delivery of the winter collection', lines: [{ skuId: a.id, quantity: 20, unitCost: '12.50' }, { skuId: b.id, quantity: 30, unitCost: 8 }] }, key());
            // the invoice number is unique per supplier: this test file may run twice on the same database
            const created = res.status === 409 ? await receive(adminId, { supplierName: `Textile Co ${stamp}`, supplierInvoiceNumber: 'INV-2041', invoiceDate: '2026-10-30', note: 'First delivery of the winter collection', lines: [{ skuId: a.id, quantity: 20, unitCost: '12.50' }, { skuId: b.id, quantity: 30, unitCost: 8 }] }) : res;
            expect(created.status, JSON.stringify(created.body)).toBe(201);
            expect(created.body).toMatchObject({ supplierInvoiceNumber: 'INV-2041', invoiceDate: '2026-10-30', currency: 'USD', totalCost: '490.00', note: 'First delivery of the winter collection', lineCount: 2, totalQuantity: 50, receivedBy: { id: adminId, name: 'Test gradmin' }, warehouse: { id: warehouseId } });
            expect(created.body.supplierName).toMatch(/^Textile Co/);
            expect(created.body.reference).toMatch(/^GR-\d{8}$/);
            const line = created.body.lines.find((l: { sku: { id: string } }) => l.sku.id === a.id);
            expect(line).toMatchObject({ quantity: 20, unitCost: '12.50', lineTotal: '250.00' });
            expect(created.body.lines.find((l: { sku: { id: string } }) => l.sku.id === b.id)).toMatchObject({ unitCost: '8.00', lineTotal: '240.00' });

            expect([await qty(warehouseId, a.id), await qty(warehouseId, b.id)]).toEqual([20, 30]);
            const ledger = await prisma.stockMovement.findMany({ where: { goodsReceiptId: created.body.id }, orderBy: { quantityDelta: 'asc' } });
            expect(ledger).toHaveLength(2);
            expect(ledger[0]).toMatchObject({ movementType: 'goods_receipt', bucket: 'sellable', branchId: warehouseId, balanceAfter: 20, actorUserId: adminId, reason: 'supplier delivery' });
            const audit = await request(app).get(`/audit-events?entityType=goods_receipt&entityId=${created.body.id}`).set(as(adminId));
            expect(audit.body[0]).toMatchObject({ action: 'goods_receipt.create', by: { id: adminId }, details: { invoice: 'INV-2041', pieces: 50, total: '490.00' } });
            const moves = await request(app).get(`/stock/movements?branchId=${warehouseId}&skuId=${a.id}&type=goods_receipt`).set(as(adminId));
            expect(moves.body[0]).toMatchObject({ type: 'goods_receipt', quantityDelta: 20 });
            const diffs = await prisma.$queryRaw<{ sku_id: string }[]>`SELECT sku_id FROM v_stock_reconciliation_diffs WHERE sku_id IN (${a.id}::uuid, ${b.id}::uuid)`;
            expect(diffs).toEqual([]);
        });

        it('the next delivery of the same product adds to the stock; the date is today when not given; a free sample costs 0', async () => {
            const sku = await newSku();
            expect((await receive(adminId, { invoiceDate: undefined, lines: [{ skuId: sku.id, quantity: 10, unitCost: '5.00' }] })).body.invoiceDate).toBe(today);
            const second = await receive(adminId, { lines: [{ skuId: sku.id, quantity: 7, unitCost: 0 }] });
            expect(second.status, JSON.stringify(second.body)).toBe(201);
            expect(second.body.totalCost).toBe('0.00');
            expect(await qty(warehouseId, sku.id)).toBe(17);
        });

        it('what came into the warehouse can be sent on to a branch', async () => {
            const sku = await newSku();
            await receive(adminId, { lines: [{ skuId: sku.id, quantity: 10, unitCost: '3.00' }] });
            const t = await request(app).post('/transfers').set(as(adminId)).set('Idempotency-Key', key()).send({ sourceBranchId: warehouseId, destinationBranchId: hamraId, lines: [{ skuId: sku.id, quantity: 4 }] });
            expect((await request(app).post(`/transfers/${t.body.id}/dispatch`).set(as(adminId)).set('Idempotency-Key', key())).status).toBe(200);
            expect(await qty(warehouseId, sku.id)).toBe(6);
        });
    });

    describe('what is refused', () => {
        it('the same supplier invoice twice (any letter case, any spacing) is refused with the first reference; the same number from another supplier is fine', async () => {
            const sku = await newSku();
            const supplierName = `Duplicate Supplier ${stamp}`;
            const first = await receive(adminId, { supplierName, supplierInvoiceNumber: 'A-100', lines: [{ skuId: sku.id, quantity: 5, unitCost: '2.00' }] });
            expect(first.status).toBe(201);
            for (const patch of [{}, { supplierName: supplierName.toUpperCase() }, { supplierInvoiceNumber: ' a-100 ' }]) {
                const again = await receive(adminId, { supplierName, supplierInvoiceNumber: 'A-100', ...patch, lines: [{ skuId: sku.id, quantity: 5, unitCost: '2.00' }] });
                expect(again.status, JSON.stringify(patch)).toBe(409);
                expect(again.body.message).toBe(`This supplier invoice was already received as ${first.body.reference}`);
            }
            expect(await qty(warehouseId, sku.id)).toBe(5);                                           // counted once
            const other = await receive(adminId, { supplierName: `Another Supplier ${stamp}`, supplierInvoiceNumber: 'A-100', lines: [{ skuId: sku.id, quantity: 1, unitCost: '2.00' }] });
            expect(other.status).toBe(201);
        });

        it('an archived or unknown product is refused and nothing changes', async () => {
            const live = await newSku();
            const archived = await newSku();
            await request(app).patch(`/skus/${archived.id}`).set(as(adminId)).send({ isActive: false });
            const before = await prisma.goodsReceipt.count();
            const res = await receive(adminId, { lines: [{ skuId: live.id, quantity: 3, unitCost: '1.00' }, { skuId: archived.id, quantity: 3, unitCost: '1.00' }] });
            expect(res.status).toBe(409);
            expect(res.body.message).toContain(archived.skuCode);
            expect((await receive(adminId, { lines: [{ skuId: randomUUID(), quantity: 1, unitCost: '1.00' }] })).status).toBe(404);
            expect([await qty(warehouseId, live.id), await prisma.goodsReceipt.count()]).toEqual([0, before]);
        });

        it('every bad body is a 400, and the Idempotency-Key is required', async () => {
            const sku = await newSku();
            const ok = { lines: [{ skuId: sku.id, quantity: 1, unitCost: '1.00' }] };
            for (const patch of [{ supplierName: undefined }, { supplierName: 'X' }, { supplierInvoiceNumber: 'x'.repeat(51) }, { invoiceDate: '2999-01-01' }, { invoiceDate: '2026-02-30' }, { currency: 'dollars' },
                { lines: [] }, { lines: undefined }, { lines: [{ skuId: sku.id, quantity: 0, unitCost: '1.00' }] }, { lines: [{ skuId: sku.id, quantity: 1 }] }, { lines: [{ skuId: sku.id, quantity: 1, unitCost: '-2' }] },
                { lines: [{ skuId: sku.id, quantity: 1, unitCost: '1.00' }, { skuId: sku.id, quantity: 2, unitCost: '1.00' }] }]) {
                expect((await receive(adminId, { ...ok, ...patch })).status, JSON.stringify(patch).slice(0, 70)).toBe(400);
            }
            expect((await request(app).post('/goods-receipts').set(as(adminId)).send({ supplierName: 'Supplier X', supplierInvoiceNumber: 'N1', ...ok })).status).toBe(400);
            expect((await request(app).post('/goods-receipts').set(as(adminId)).set('Idempotency-Key', key())).status).toBe(400);
            expect(await qty(warehouseId, sku.id)).toBe(0);
        });
    });

    describe('who may receive', () => {
        it('the admin; a manager who reaches the warehouse; nobody else', async () => {
            const sku = await newSku();
            const lines = [{ skuId: sku.id, quantity: 2, unitCost: '1.00' }];
            expect((await receive(adminId, { lines })).status).toBe(201);
            expect((await receive(warehouseManagerId, { lines })).status).toBe(201);
            expect((await receive(hamraManagerId, { lines })).status).toBe(403);                      // a branch manager does not reach the warehouse
            expect((await receive(staffId, { lines })).status).toBe(403);                             // an employee has no permission
            expect((await request(app).post('/goods-receipts').send({})).status).toBe(401);
            expect(await qty(warehouseId, sku.id)).toBe(4);
        });

        it('an employee given the permission still needs to reach the warehouse', async () => {
            const emp = await make('grperm', UserRole.EMPLOYEE);
            await request(app).put(`/users/${emp}/branches/${hamraId}`).set(as(adminId));
            await request(app).put(`/users/${emp}/permissions`).set(as(adminId)).send({ permissions: { 'adjustments.create': true } });
            const sku = await newSku();
            expect((await receive(emp, { lines: [{ skuId: sku.id, quantity: 1, unitCost: '1.00' }] })).status).toBe(403);
            await request(app).put(`/users/${emp}/branches/${warehouseId}`).set(as(adminId));
            expect((await receive(emp, { lines: [{ skuId: sku.id, quantity: 1, unitCost: '1.00' }] })).status).toBe(201);
        });
    });

    describe('retries and races', () => {
        it('the same request again (a retry) is done once; the same key for another request is refused', async () => {
            const sku = await newSku();
            const k = key();
            const body = { supplierInvoiceNumber: `RETRY-${stamp}`, lines: [{ skuId: sku.id, quantity: 6, unitCost: '2.50' }] };
            const first = await receive(adminId, body, k);
            const again = await receive(adminId, body, k);
            expect([first.status, again.status, again.headers['idempotent-replay'], first.headers['idempotent-replay']]).toEqual([201, 201, 'true', undefined]);
            expect(again.body.id).toBe(first.body.id);
            expect(await qty(warehouseId, sku.id)).toBe(6);
            expect((await receive(adminId, { ...body, lines: [{ skuId: sku.id, quantity: 7, unitCost: '2.50' }] }, k)).status).toBe(409);
        });

        it('the same supplier invoice entered by 4 people at the same moment: exactly one is received', async () => {
            const sku = await newSku();
            const results = await Promise.all(Array.from({ length: 4 }, () => receive(adminId, { supplierName: `Race Supplier ${stamp}`, supplierInvoiceNumber: 'RACE-1', lines: [{ skuId: sku.id, quantity: 5, unitCost: '1.00' }] })));
            expect(results.filter((r) => r.status === 201)).toHaveLength(1);
            expect(results.filter((r) => r.status === 409)).toHaveLength(3);
            expect(await qty(warehouseId, sku.id)).toBe(5);
        });

        it('deliveries of the same product at the same moment all count', async () => {
            const sku = await newSku();
            const results = await Promise.all(Array.from({ length: 6 }, () => receive(adminId, { lines: [{ skuId: sku.id, quantity: 3, unitCost: '1.00' }] })));
            expect(results.every((r) => r.status === 201)).toBe(true);
            expect(await qty(warehouseId, sku.id)).toBe(18);
            const diffs = await prisma.$queryRaw<{ sku_id: string }[]>`SELECT sku_id FROM v_stock_reconciliation_diffs WHERE sku_id = ${sku.id}::uuid`;
            expect(diffs).toEqual([]);
        });
    });

    describe('reading the documents', () => {
        it('the list: newest first with the total; filters by supplier, invoice number, product and date; one document with its lines', async () => {
            const sku = await newSku();
            const supplierName = `Lister Supplier ${stamp}`;
            for (const [number, date] of [['L-1', '2026-10-01'], ['L-2', '2026-10-15'], ['L-3', '2026-10-30']] as const) {
                expect((await receive(adminId, { supplierName, supplierInvoiceNumber: number, invoiceDate: date, lines: [{ skuId: sku.id, quantity: 1, unitCost: '1.00' }] })).status).toBe(201);
            }
            const mine = await request(app).get(`/goods-receipts?supplier=lister%20supplier&skuId=${sku.id}`).set(as(adminId));
            expect(mine.status).toBe(200);
            expect(mine.headers['x-total-count']).toBe('3');
            expect(mine.body.map((r: { supplierInvoiceNumber: string }) => r.supplierInvoiceNumber)).toEqual(['L-3', 'L-2', 'L-1']);        // newest entered first
            expect(mine.body[0]).toMatchObject({ lineCount: 1, totalQuantity: 1, totalCost: '1.00' });
            expect(mine.body[0].lines).toBeUndefined();                                               // the list is a summary
            expect((await request(app).get(`/goods-receipts?supplier=${encodeURIComponent(supplierName)}&invoiceNumber=l-2`).set(as(adminId))).body).toHaveLength(1);
            expect((await request(app).get(`/goods-receipts?skuId=${sku.id}&from=2026-10-10&to=2026-10-20`).set(as(adminId))).body.map((r: { supplierInvoiceNumber: string }) => r.supplierInvoiceNumber)).toEqual(['L-2']);
            const page = await request(app).get(`/goods-receipts?skuId=${sku.id}&limit=1&offset=2`).set(as(adminId));
            expect([page.body.length, page.headers['x-total-count']]).toEqual([1, '3']);
            expect((await request(app).get(`/goods-receipts?supplier=%25`).set(as(adminId))).body).toEqual([]);                              // a % is just a character

            const one = await request(app).get(`/goods-receipts/${mine.body[0].id}`).set(as(warehouseManagerId));
            expect(one.status).toBe(200);
            expect(one.body.lines).toHaveLength(1);
            expect((await request(app).get(`/goods-receipts/${randomUUID()}`).set(as(adminId))).status).toBe(404);
            expect((await request(app).get('/goods-receipts/abc').set(as(adminId))).status).toBe(404);
            expect((await request(app).get('/goods-receipts').set(as(hamraManagerId))).status).toBe(403);
            expect((await request(app).get(`/goods-receipts/${mine.body[0].id}`).set(as(staffId))).status).toBe(403);
            expect((await request(app).get('/goods-receipts')).status).toBe(401);
            for (const q of ['from=2026-02-30', 'from=2026-11-01&to=2026-10-01', 'skuId=abc', 'limit=0', 'offset=-1', 'supplier=']) expect((await request(app).get(`/goods-receipts?${q}`).set(as(adminId))).status, q).toBe(400);
        });

        it('a receipt can never be edited or deleted', async () => {
            const sku = await newSku();
            const res = await receive(adminId, { lines: [{ skuId: sku.id, quantity: 1, unitCost: '1.00' }] });
            await expect(prisma.goodsReceipt.update({ where: { id: res.body.id }, data: { note: 'Changed afterwards' } })).rejects.toThrow();
            await expect(prisma.goodsReceipt.delete({ where: { id: res.body.id } })).rejects.toThrow();
            await expect(prisma.goodsReceiptLine.deleteMany({ where: { receiptId: res.body.id } })).rejects.toThrow();
        });
    });
});
