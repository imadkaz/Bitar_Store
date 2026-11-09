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

// A transfer between two branches has TWO invoices (BL-03): a RETURN invoice from the sending branch to the warehouse and a SALES invoice from the
// warehouse to the receiving branch. The goods never enter the warehouse. A branch returning goods to the warehouse has the return invoice.
const disposable = process.env.TEST_DB_DISPOSABLE === '1';
const stamp = Date.now();
const short = String(stamp).slice(-8);
const tokens = new JwtTokenService(process.env.JWT_SECRET!);
const as = (id: string) => ({ Authorization: `Bearer ${tokens.sign(id)}` });
const key = () => `bt-${randomUUID()}`;
let counter = 0;

let adminId = '', warehouseMgrId = '', mgrAId = '', mgrBId = '', warehouseId = '', aId = '', bId = '';
const body = (res: request.Response) => res.body;

const newStocked = async (warehouseQuantity = 30, cost = '10.00') => {
    const styleId = (await request(app).post('/styles').set(as(adminId)).send({ code: `BT${short}${++counter}`, name: `Branch Transfer Dress ${counter}` })).body.id;
    const sku = (await request(app).post('/skus').set(as(adminId)).send({ styleId, skuCode: `BT${short}-${counter}`, size: 'M', color: 'Grey', standardPrice: '99.00' })).body;
    expect((await request(app).post('/goods-receipts').set(as(adminId)).set('Idempotency-Key', key()).send({ supplierName: `BT Supplier ${short}`, lines: [{ skuId: sku.id, quantity: warehouseQuantity, unitCost: cost }] })).status).toBe(201);
    return sku.id as string;
};
const create = (userId: string, from: string, to: string, lines: { skuId: string; quantity: number }[]) => request(app).post('/transfers').set(as(userId)).set('Idempotency-Key', key()).send({ sourceBranchId: from, destinationBranchId: to, lines });
const dispatch = (userId: string, id: string) => request(app).post(`/transfers/${id}/dispatch`).set(as(userId)).set('Idempotency-Key', key());
// the warehouse sends to A and A receives: A has the pieces
const stockBranchA = async (skuId: string, quantity: number) => {
    const t = await create(adminId, warehouseId, aId, [{ skuId, quantity }]);
    expect((await dispatch(adminId, t.body.id)).status).toBe(200);
    expect((await request(app).post(`/transfers/${t.body.id}/receive`).set(as(mgrAId)).set('Idempotency-Key', key()).send({ lines: [{ skuId, accepted: quantity }] })).status).toBe(200);
};
const balance = async (branchId: string, skuId: string, bucket: string) => (await prisma.stockBalance.findFirst({ where: { branchId, skuId, bucket } }))?.quantity ?? 0;
const invoicesOf = async (transferId: string) => (await request(app).get(`/invoices?transferId=${transferId}`).set(as(adminId))).body as { id: string; kind: string; status: string; total: string; issuer: { id: string }; recipient: { branchId: string }; reference: string | null }[];

describe.skipIf(!disposable)('transfers between branches and their two invoices (real database)', () => {
    beforeAll(async () => {
        await waitForDatabase(prisma);
        const make = async (tag: string, role: UserRole) => (await createUserWithPassword(new UserRepository(prisma), { email: `${tag}-${stamp}@bitar.test`, password: 'Password#123', fullName: `Test ${tag}`, role }, null)).getId();
        adminId = await make('btadmin', UserRole.ADMIN);
        warehouseMgrId = await make('btwm', UserRole.MANAGER);
        mgrAId = await make('btma', UserRole.MANAGER);
        mgrBId = await make('btmb', UserRole.MANAGER);
        const all = await request(app).get('/branches').set(as(adminId));
        warehouseId = all.body.find((b: { kind: string }) => b.kind === 'warehouse')?.id;
        if (!warehouseId) warehouseId = (await request(app).post('/branches').set(as(adminId)).send({ code: `BW${short}`, name: 'Main Warehouse (branch transfer test)', kind: 'warehouse' })).body.id;
        await request(app).patch(`/branches/${warehouseId}`).set(as(adminId)).send({ isActive: true });
        aId = (await request(app).post('/branches').set(as(adminId)).send({ code: `BA${short}`, name: 'Branch A' })).body.id;
        bId = (await request(app).post('/branches').set(as(adminId)).send({ code: `BB${short}`, name: 'Branch B' })).body.id;
        for (const [user, branch] of [[warehouseMgrId, warehouseId], [mgrAId, aId], [mgrBId, bId]]) expect((await request(app).put(`/users/${user}/branches/${branch}`).set(as(adminId))).status).toBe(204);
    }, 120_000);

    it('from A to B: a return invoice from A to the warehouse and a sales invoice from the warehouse to B, both at the warehouse cost; the goods never enter the warehouse', async () => {
        const sku = await newStocked(30, '10.00');
        await stockBranchA(sku, 20);
        const warehouseBefore = [await balance(warehouseId, sku, 'sellable'), await balance(warehouseId, sku, 'non_sellable')];
        const t = await create(mgrAId, aId, bId, [{ skuId: sku, quantity: 4 }]);
        expect(t.status, JSON.stringify(t.body)).toBe(201);
        expect((await dispatch(mgrAId, t.body.id)).status).toBe(200);
        const found = await invoicesOf(t.body.id);
        expect(found.map((i) => i.kind).sort()).toEqual(['b2b', 'b2b_return']);
        const ret = found.find((i) => i.kind === 'b2b_return')!, supply = found.find((i) => i.kind === 'b2b')!;
        expect(ret).toMatchObject({ status: 'draft', reference: null, total: '40.00', issuer: { id: aId }, recipient: { branchId: warehouseId } });          // A returns to the warehouse
        expect(supply).toMatchObject({ status: 'draft', reference: null, total: '40.00', issuer: { id: warehouseId }, recipient: { branchId: bId } });      // the warehouse sells to B
        const detail = body(await request(app).get(`/invoices/${ret.id}`).set(as(adminId)));
        expect(detail.lines).toHaveLength(1);
        expect(detail.lines[0]).toMatchObject({ quantity: 4, unitPrice: '10.00', priceSource: 'cost' });
        const transfer = body(await request(app).get(`/transfers/${t.body.id}`).set(as(adminId)));
        expect(transfer.returnInvoice).toMatchObject({ id: ret.id, status: 'draft', total: '40.00' });
        expect(transfer.supplyInvoice).toMatchObject({ id: supply.id, status: 'draft', total: '40.00' });
        expect([await balance(warehouseId, sku, 'sellable'), await balance(warehouseId, sku, 'non_sellable')]).toEqual(warehouseBefore);       // the warehouse did not touch the pieces
        expect(await balance(aId, sku, 'sellable')).toBe(16);
        expect(await balance(bId, sku, 'in_transit')).toBe(4);
        expect((await request(app).get(`/invoices?transferId=${t.body.id}&kind=b2b_return`).set(as(adminId))).body.map((i: { id: string }) => i.id)).toEqual([ret.id]);
    });

    it('each invoice is handled by the place that ISSUES it; the receiving branch sees only the sales invoice; each kind has its own number series and its own PDF', async () => {
        const sku = await newStocked(30, '10.00');
        await stockBranchA(sku, 20);
        const t = await create(mgrAId, aId, bId, [{ skuId: sku, quantity: 3 }]);
        await dispatch(mgrAId, t.body.id);
        const found = await invoicesOf(t.body.id);
        const ret = found.find((i) => i.kind === 'b2b_return')!, supply = found.find((i) => i.kind === 'b2b')!;
        const patch = (userId: string, id: string, price: string) => request(app).patch(`/invoices/${id}`).set(as(userId)).send({ lines: [{ skuId: sku, unitPrice: price }] });
        const edited = await patch(mgrAId, ret.id, '12.00');                                                    // A issues the return invoice
        expect(edited.status, JSON.stringify(edited.body)).toBe(200);
        expect(edited.body).toMatchObject({ total: '36.00' });
        expect(edited.body.lines[0].priceSource).toBe('manual');
        expect((await patch(mgrAId, supply.id, '15.00')).status).toBe(404);                                      // A does not issue it and it is not addressed to A
        expect((await patch(mgrBId, supply.id, '15.00')).status).toBe(403);                                      // B receives it: it can read it, not change it
        expect((await patch(warehouseMgrId, supply.id, '15.00')).status).toBe(200);                              // the warehouse issues it
        const finalReturn = await request(app).post(`/invoices/${ret.id}/finalize`).set(as(mgrAId));
        const finalSupply = await request(app).post(`/invoices/${supply.id}/finalize`).set(as(warehouseMgrId));
        expect(finalReturn.status).toBe(200);
        expect(finalSupply.status).toBe(200);
        expect(finalReturn.body.reference).toMatch(/^B2BR-\d{8}$/);
        expect(finalSupply.body.reference).toMatch(/^B2B-\d{8}$/);
        expect((await request(app).get(`/invoices/${supply.id}`).set(as(mgrBId))).status).toBe(200);
        expect((await request(app).get(`/invoices/${ret.id}`).set(as(mgrBId))).status).toBe(404);                // B has nothing to do with A returning to the warehouse
        expect((await request(app).get(`/invoices/${supply.id}`).set(as(mgrAId))).status).toBe(404);
        expect((await request(app).get(`/invoices/${ret.id}`).set(as(warehouseMgrId))).status).toBe(200);        // the warehouse is the recipient of the return invoice
        const pdf = await request(app).get(`/invoices/${ret.id}/pdf`).set(as(mgrAId)).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
        expect(pdf.status).toBe(200);
        expect(pdf.headers['content-disposition']).toBe(`inline; filename="${finalReturn.body.reference}.pdf"`);
        expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('a branch that returns goods to the warehouse has only the return invoice; one live invoice of each kind per transfer; a voided one can be made again', async () => {
        const sku = await newStocked(30, '10.00');
        await stockBranchA(sku, 10);
        const back = await create(mgrAId, aId, warehouseId, [{ skuId: sku, quantity: 2 }]);
        expect(back.status, JSON.stringify(back.body)).toBe(201);
        expect((await dispatch(mgrAId, back.body.id)).status).toBe(200);
        const found = await invoicesOf(back.body.id);
        expect(found.map((i) => i.kind)).toEqual(['b2b_return']);
        expect(found[0]).toMatchObject({ issuer: { id: aId }, recipient: { branchId: warehouseId }, total: '20.00' });
        const detail = body(await request(app).get(`/transfers/${back.body.id}`).set(as(adminId)));
        expect([detail.supplyInvoice, detail.returnInvoice?.id]).toEqual([null, found[0].id]);
        const again = await request(app).post('/invoices').set(as(mgrAId)).send({ transferId: back.body.id });
        expect(again.status).toBe(409);
        expect(again.body.message).toMatch(/already has a draft return invoice/);
        expect((await request(app).post('/invoices').set(as(adminId)).send({ transferId: back.body.id, invoiceKind: 'b2b' })).status).toBe(409);      // there is no supply invoice for a return
        await request(app).post(`/invoices/${found[0].id}/finalize`).set(as(mgrAId));
        expect((await request(app).post(`/invoices/${found[0].id}/void`).set(as(mgrAId)).send({ reason: 'Wrong price' })).status).toBe(200);
        const redone = await request(app).post('/invoices').set(as(mgrAId)).send({ transferId: back.body.id });
        expect(redone.status, JSON.stringify(redone.body)).toBe(201);
        expect(redone.body.kind).toBe('b2b_return');
    });

    it('made by hand: the return invoice by the sending branch, the supply invoice by the warehouse side only', async () => {
        const sku = await newStocked(30, '10.00');
        await stockBranchA(sku, 10);
        const t = await create(mgrAId, aId, bId, [{ skuId: sku, quantity: 2 }]);
        await dispatch(mgrAId, t.body.id);
        for (const i of await invoicesOf(t.body.id)) expect((await request(app).delete(`/invoices/${i.id}`).set(as(adminId))).status).toBe(204);
        const asA = (invoiceKind: string) => request(app).post('/invoices').set(as(mgrAId)).send({ transferId: t.body.id, invoiceKind });
        expect((await asA('b2b')).status).toBe(403);                                  // A reaches the transfer but the warehouse issues the supply invoice
        expect((await request(app).post('/invoices').set(as(mgrBId)).send({ transferId: t.body.id, invoiceKind: 'b2b_return' })).status).toBe(403);
        const stranger = (await createUserWithPassword(new UserRepository(prisma), { email: `btstranger-${stamp}-${++counter}@bitar.test`, password: 'Password#123', fullName: 'Stranger', role: UserRole.MANAGER }, null)).getId();
        expect((await request(app).post('/invoices').set(as(stranger)).send({ transferId: t.body.id })).status).toBe(404);
        expect((await asA('b2b_return')).status).toBe(201);
        expect((await request(app).post('/invoices').set(as(warehouseMgrId)).send({ transferId: t.body.id, invoiceKind: 'b2b' })).status).toBe(201);
        expect((await invoicesOf(t.body.id)).map((i) => i.kind).sort()).toEqual(['b2b', 'b2b_return']);
        expect((await request(app).post('/invoices').set(as(mgrAId)).send({ transferId: t.body.id, invoiceKind: 'b2c' })).status).toBe(400);
    });

    it('pieces whose cost is not known are priced 0 on both invoices and cannot be finalized until a price is set', async () => {
        const styleId = (await request(app).post('/styles').set(as(adminId)).send({ code: `BU${short}${++counter}`, name: 'No cost dress' })).body.id;
        const sku = (await request(app).post('/skus').set(as(adminId)).send({ styleId, skuCode: `BU${short}-${counter}`, size: 'S', color: 'Red', standardPrice: '50.00' })).body.id;
        await request(app).post('/stock/opening').set(as(adminId)).set('Idempotency-Key', key()).send({ branchId: aId, lines: [{ skuId: sku, quantity: 5 }] });      // opening stock at A: no cost anywhere
        const t = await create(mgrAId, aId, bId, [{ skuId: sku, quantity: 2 }]);
        await dispatch(mgrAId, t.body.id);
        const found = await invoicesOf(t.body.id);
        expect(found.map((i) => i.total)).toEqual(['0.00', '0.00']);
        const ret = found.find((i) => i.kind === 'b2b_return')!;
        expect((await request(app).post(`/invoices/${ret.id}/finalize`).set(as(mgrAId))).status).toBe(409);
        expect((await request(app).patch(`/invoices/${ret.id}`).set(as(mgrAId)).send({ lines: [{ skuId: sku, unitPrice: '20.00' }] })).status).toBe(200);
        expect((await request(app).post(`/invoices/${ret.id}/finalize`).set(as(mgrAId))).status).toBe(200);
    });
});
