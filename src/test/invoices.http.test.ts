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

// Invoices, audit events and the numbers they take can never be deleted: only on a database you can throw away.
const disposable = process.env.TEST_DB_DISPOSABLE === '1';

const stamp = Date.now();
const tokens = new JwtTokenService(process.env.JWT_SECRET!);
const as = (id: string) => ({ Authorization: `Bearer ${tokens.sign(id)}` });
const key = () => `inv-${randomUUID()}`;

let adminId = '', warehouseManagerId = '', hamraManagerId = '', tripoliManagerId = '', staffId = '';
let hamraId = '', tripoliId = '', warehouseId = '', styleId = '';
let counter = 0;

const newSku = async (price = '20.00') => {
    const res = await request(app).post('/skus').set(as(adminId)).send({ styleId, skuCode: `IV${stamp}-${++counter}`, size: `S${counter}`, color: 'Grey', standardPrice: price });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; skuCode: string };
};
const stock = async (skuId: string, branchId: string, quantity: number) => {
    const res = await request(app).post('/stock/opening').set(as(adminId)).set('Idempotency-Key', key()).send({ branchId, lines: [{ skuId, quantity }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
};
// a transfer from the warehouse to Hamra that has been SENT
const sentTransfer = async (lines: { skuId: string; quantity: number }[], to = hamraId) => {
    for (const l of lines) await stock(l.skuId, warehouseId, l.quantity + 5);
    const t = await request(app).post('/transfers').set(as(adminId)).set('Idempotency-Key', key()).send({ sourceBranchId: warehouseId, destinationBranchId: to, lines });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect((await request(app).post(`/transfers/${t.body.id}/dispatch`).set(as(adminId)).set('Idempotency-Key', key())).status).toBe(200);
    return t.body.id as string;
};
const sale = async (skuId: string, branchId: string, quantity = 2, discount = false) => {
    await stock(skuId, branchId, quantity + 3);
    const line = { skuId, quantity, ...(discount ? { discount: { type: 'percent', percent: '10', reason: 'loyal customer' } } : {}) };
    const price = 20 * quantity * (discount ? 0.9 : 1);
    const res = await request(app).post('/sales').set(as(adminId)).set('Idempotency-Key', key()).send({ branchId, lines: [line], payments: [{ method: 'cash', amount: (price - 5).toFixed(2) }, { method: 'whish', amount: '5.00', reference: `IV-${stamp}-${++counter}` }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; reference: string; total: string };
};
const make = async (tag: string, role: UserRole) => (await createUserWithPassword(new UserRepository(prisma), { email: `${tag}-${stamp}@bitar.test`, password: 'Password#123', fullName: `Test ${tag}`, role }, adminId)).getId();
const invoice = (userId: string, body: object) => request(app).post('/invoices').set(as(userId)).send(body);

describe.skipIf(!disposable)('invoices (real database)', () => {
    beforeAll(async () => {
        await waitForDatabase(prisma);
        adminId = (await createUserWithPassword(new UserRepository(prisma), { email: `ivadmin-${stamp}@bitar.test`, password: 'Password#123', fullName: 'Test ivadmin', role: UserRole.ADMIN }, null)).getId();
        warehouseManagerId = await make('ivwm', UserRole.MANAGER);
        hamraManagerId = await make('ivhm', UserRole.MANAGER);
        tripoliManagerId = await make('ivtm', UserRole.MANAGER);
        staffId = await make('ivs', UserRole.EMPLOYEE);
        hamraId = (await request(app).post('/branches').set(as(adminId)).send({ code: `IVH-${stamp}`, name: 'Hamra (invoice test)' })).body.id;
        tripoliId = (await request(app).post('/branches').set(as(adminId)).send({ code: `IVT-${stamp}`, name: 'Tripoli (invoice test)' })).body.id;
        const all = await request(app).get('/branches').set(as(adminId));
        warehouseId = all.body.find((b: { kind: string }) => b.kind === 'warehouse')?.id;
        if (!warehouseId) warehouseId = (await request(app).post('/branches').set(as(adminId)).send({ code: `IVW-${stamp}`, name: 'Main Warehouse (test)', kind: 'warehouse' })).body.id;
        await request(app).patch(`/branches/${warehouseId}`).set(as(adminId)).send({ isActive: true });          // an earlier test may have left the one and only warehouse inactive
        for (const [user, branch] of [[warehouseManagerId, warehouseId], [hamraManagerId, hamraId], [tripoliManagerId, tripoliId], [staffId, hamraId]]) expect((await request(app).put(`/users/${user}/branches/${branch}`).set(as(adminId))).status).toBe(204);
        styleId = (await request(app).post('/styles').set(as(adminId)).send({ code: `IVS${stamp}`, name: 'Invoice Test Dress' })).body.id;
    }, 120_000);

    describe('the supply invoice (b2b): a draft from a transfer, prices adjusted, then final', () => {
        it('made from what was SENT, priced from the catalog, addressed to the branch; a draft has no number; the names are copied', async () => {
            const a = await newSku('95.00');
            const b = await newSku('12.50');
            const transferId = await sentTransfer([{ skuId: a.id, quantity: 20 }, { skuId: b.id, quantity: 30 }]);
            const res = await invoice(warehouseManagerId, { transferId, note: 'Winter collection' });
            expect(res.status, JSON.stringify(res.body)).toBe(201);
            expect(res.body).toMatchObject({ kind: 'b2b', status: 'draft', reference: null, currency: 'USD', subtotal: '2275.00', discountTotal: '0.00', total: '2275.00', note: 'Winter collection', lineCount: 2, finalizedAt: null, voided: null,
                issuer: { id: warehouseId }, recipient: { branchId: hamraId, name: 'Hamra (invoice test)' }, issuedBy: { id: warehouseManagerId, name: 'Test ivwm' }, sale: null, payments: [] });
            expect(res.body.transfer.id).toBe(transferId);
            const line = res.body.lines.find((l: { sku: { code: string } }) => l.sku.code === a.skuCode);
            expect(line).toMatchObject({ quantity: 20, unitPrice: '95.00', discount: '0.00', lineTotal: '1900.00', description: 'Invoice Test Dress, S' + a.skuCode.split('-')[1] + ', Grey' });
        });

        it('the prices of a draft can be adjusted until it is final; the total follows; each change is recorded; the catalog price does not move', async () => {
            const a = await newSku('95.00');
            const b = await newSku('12.50');
            const transferId = await sentTransfer([{ skuId: a.id, quantity: 20 }, { skuId: b.id, quantity: 30 }]);
            const draft = (await invoice(adminId, { transferId })).body;
            const edited = await request(app).patch(`/invoices/${draft.id}`).set(as(warehouseManagerId)).send({ lines: [{ skuId: a.id, unitPrice: '80.00' }, { skuId: b.id, unitPrice: 10 }], note: 'Agreed price for the opening' });
            expect(edited.status, JSON.stringify(edited.body)).toBe(200);
            expect(edited.body).toMatchObject({ subtotal: '1900.00', total: '1900.00', note: 'Agreed price for the opening', status: 'draft' });      // 20 x 80 + 30 x 10
            expect(edited.body.lines.map((l: { unitPrice: string; lineTotal: string }) => [l.unitPrice, l.lineTotal]).sort()).toEqual([['10.00', '300.00'], ['80.00', '1600.00']]);
            expect((await request(app).get(`/skus/${a.id}`).set(as(adminId))).body.standardPrice).toBe('95.00');
            const again = await request(app).patch(`/invoices/${draft.id}`).set(as(adminId)).send({ lines: [{ skuId: b.id, unitPrice: '11.00' }] });
            expect(again.body.total).toBe('1930.00');
            const audit = await request(app).get(`/audit-events?entityType=invoice&entityId=${draft.id}`).set(as(adminId));
            expect(audit.body.map((e: { action: string }) => e.action).sort()).toEqual(['invoice.create', 'invoice.update', 'invoice.update']);
            const update = audit.body.find((e: { action: string; details: { total: string } }) => e.action === 'invoice.update' && e.details.total === '1900.00');
            expect(update.details.prices).toEqual(expect.arrayContaining([{ sku: a.skuCode, before: '95.00', after: '80.00' }]));
        });

        it('finalizing gives it a number and locks it: no more price changes, no delete, and it keeps its names even if the product is renamed', async () => {
            const a = await newSku('50.00');
            const transferId = await sentTransfer([{ skuId: a.id, quantity: 4 }]);
            const draft = (await invoice(adminId, { transferId })).body;
            const final = await request(app).post(`/invoices/${draft.id}/finalize`).set(as(warehouseManagerId));
            expect(final.status, JSON.stringify(final.body)).toBe(200);
            expect(final.body).toMatchObject({ status: 'final', total: '200.00' });
            expect(final.body.reference).toMatch(/^B2B-\d{8}$/);
            expect(final.body.finalizedAt).toBeTruthy();
            expect((await request(app).patch(`/invoices/${draft.id}`).set(as(adminId)).send({ lines: [{ skuId: a.id, unitPrice: '1.00' }] })).status).toBe(409);
            expect((await request(app).delete(`/invoices/${draft.id}`).set(as(adminId))).status).toBe(409);
            expect((await request(app).post(`/invoices/${draft.id}/finalize`).set(as(adminId))).status).toBe(409);
            await request(app).patch(`/styles/${styleId}`).set(as(adminId)).send({ name: 'Renamed Dress' });
            const reread = await request(app).get(`/invoices/${draft.id}`).set(as(adminId));
            expect(reread.body.lines[0].description).toMatch(/^Invoice Test Dress/);                         // copied when it was made
            await request(app).patch(`/styles/${styleId}`).set(as(adminId)).send({ name: 'Invoice Test Dress' });
            await expect(prisma.$executeRaw`UPDATE invoices SET total = 1, subtotal = 1 WHERE id = ${draft.id}::uuid`).rejects.toThrow();     // the database refuses too
            await expect(prisma.$executeRaw`DELETE FROM invoice_lines WHERE invoice_id = ${draft.id}::uuid`).rejects.toThrow();
        });

        it('a mistake is VOIDED (it stays, with who and why), and then a new invoice can be made for the same transfer', async () => {
            const a = await newSku('30.00');
            const transferId = await sentTransfer([{ skuId: a.id, quantity: 3 }]);
            const first = (await invoice(adminId, { transferId })).body;
            await request(app).post(`/invoices/${first.id}/finalize`).set(as(adminId));
            expect((await invoice(adminId, { transferId })).status).toBe(409);                              // one live invoice per transfer
            expect((await request(app).post(`/invoices/${first.id}/void`).set(as(adminId)).send({ reason: 'ab' })).status).toBe(400);
            const voided = await request(app).post(`/invoices/${first.id}/void`).set(as(warehouseManagerId)).send({ reason: 'Wrong price on the dresses' });
            expect(voided.status, JSON.stringify(voided.body)).toBe(200);
            expect(voided.body).toMatchObject({ status: 'void', voided: { reason: 'Wrong price on the dresses', by: { id: warehouseManagerId } } });
            expect(voided.body.reference).toBe(first.reference ? first.reference : voided.body.reference);
            expect((await request(app).post(`/invoices/${first.id}/void`).set(as(adminId)).send({ reason: 'Again' })).status).toBe(409);
            expect((await request(app).patch(`/invoices/${first.id}`).set(as(adminId)).send({ note: 'x' })).status).toBe(409);
            const second = await invoice(adminId, { transferId });
            expect(second.status, JSON.stringify(second.body)).toBe(201);
            expect(second.body.id).not.toBe(first.id);
        });

        it('a draft can be thrown away, and then it can be made again', async () => {
            const a = await newSku('10.00');
            const transferId = await sentTransfer([{ skuId: a.id, quantity: 2 }]);
            const draft = (await invoice(adminId, { transferId })).body;
            expect((await request(app).delete(`/invoices/${draft.id}`).set(as(warehouseManagerId))).status).toBe(204);
            expect((await request(app).get(`/invoices/${draft.id}`).set(as(adminId))).status).toBe(404);
            expect((await request(app).post(`/invoices/${draft.id}/void`).set(as(adminId)).send({ reason: 'Not there' })).status).toBe(404);
            expect((await invoice(adminId, { transferId })).status).toBe(201);
        });

        it('what is refused: a transfer not sent yet, a cancelled one, a return to the warehouse, a branch to branch, nothing sent', async () => {
            const a = await newSku('10.00');
            await stock(a.id, warehouseId, 10);
            const draftTransfer = (await request(app).post('/transfers').set(as(adminId)).set('Idempotency-Key', key()).send({ sourceBranchId: warehouseId, destinationBranchId: hamraId, lines: [{ skuId: a.id, quantity: 2 }] })).body.id;
            expect((await invoice(adminId, { transferId: draftTransfer })).status).toBe(409);               // nothing sent yet
            await request(app).post(`/transfers/${draftTransfer}/cancel`).set(as(adminId));
            expect((await invoice(adminId, { transferId: draftTransfer })).status).toBe(409);               // cancelled
            await stock(a.id, hamraId, 5);
            const back = (await request(app).post('/transfers').set(as(adminId)).set('Idempotency-Key', key()).send({ sourceBranchId: hamraId, destinationBranchId: warehouseId, lines: [{ skuId: a.id, quantity: 2 }] })).body.id;
            await request(app).post(`/transfers/${back}/dispatch`).set(as(adminId)).set('Idempotency-Key', key());
            const returned = await invoice(adminId, { transferId: back });
            expect(returned.status).toBe(409);
            expect(returned.body.message).toMatch(/leaves the warehouse/);
            const sideways = (await request(app).post('/transfers').set(as(adminId)).set('Idempotency-Key', key()).send({ sourceBranchId: hamraId, destinationBranchId: tripoliId, lines: [{ skuId: a.id, quantity: 1 }] })).body.id;
            await request(app).post(`/transfers/${sideways}/dispatch`).set(as(adminId)).set('Idempotency-Key', key());
            expect((await invoice(adminId, { transferId: sideways })).status).toBe(409);
            expect((await invoice(adminId, { transferId: randomUUID() })).status).toBe(404);
        });
    });

    describe('the invoice of a sale (b2c): final at once, the customer is optional', () => {
        it('with the customer name and phone: numbered, copies the sale (prices, discount, total) and shows how it was paid', async () => {
            const sku = await newSku('20.00');
            const s = await sale(sku.id, hamraId, 2, true);
            const res = await invoice(staffId, { saleId: s.id, customerName: 'رامي الخوري', customerPhone: '+961 3 123 456', note: 'Thank you' });
            expect(res.status, JSON.stringify(res.body)).toBe(201);
            expect(res.body).toMatchObject({ kind: 'b2c', status: 'final', subtotal: '40.00', discountTotal: '4.00', total: s.total, recipient: { branchId: null, name: 'رامي الخوري', phone: '+961 3 123 456' }, issuer: { id: hamraId }, transfer: null, sale: { id: s.id, reference: s.reference }, issuedBy: { id: staffId } });
            expect(res.body.reference).toMatch(/^B2C-\d{8}$/);
            expect(res.body.lines[0]).toMatchObject({ quantity: 2, unitPrice: '20.00', discount: '4.00', lineTotal: '36.00' });
            expect(res.body.payments.map((p: { method: string; amount: string }) => [p.method, p.amount])).toEqual([['cash', '31.00'], ['whish', '5.00']]);
            expect((await invoice(staffId, { saleId: s.id })).status).toBe(409);                            // one live invoice per sale
        });

        it('with no customer at all (a walk-in), and corrected by voiding it', async () => {
            const sku = await newSku('20.00');
            const s = await sale(sku.id, hamraId, 1);
            const walkIn = await invoice(hamraManagerId, { saleId: s.id });
            expect(walkIn.status).toBe(201);
            expect(walkIn.body.recipient).toEqual({ branchId: null, name: null, phone: null });
            expect((await request(app).post(`/invoices/${walkIn.body.id}/void`).set(as(staffId)).send({ reason: 'Customer name forgotten' })).status).toBe(403);         // an employee cannot void
            expect((await request(app).post(`/invoices/${walkIn.body.id}/void`).set(as(hamraManagerId)).send({ reason: 'Customer name forgotten' })).status).toBe(200);
            const again = await invoice(hamraManagerId, { saleId: s.id, customerName: 'Rami Khoury' });
            expect(again.status).toBe(201);
            expect(again.body.recipient.name).toBe('Rami Khoury');
        });

        it('only at the branch where it was sold', async () => {
            const sku = await newSku('20.00');
            const s = await sale(sku.id, hamraId, 1);
            expect((await invoice(tripoliManagerId, { saleId: s.id })).status).toBe(404);
            expect((await invoice(adminId, { saleId: randomUUID() })).status).toBe(404);
        });
    });

    describe('bad input and who may do what', () => {
        it('every bad body is a 400', async () => {
            const sku = await newSku('20.00');
            const s = await sale(sku.id, hamraId, 1);
            const t = await sentTransfer([{ skuId: sku.id, quantity: 1 }]);
            for (const body of [{}, { transferId: t, saleId: s.id }, { transferId: 'abc' }, { saleId: 5 }, { transferId: t, customerName: 'Rami' }, { saleId: s.id, customerName: 'R' }, { saleId: s.id, customerPhone: 'call me' }, { saleId: s.id, note: 'x'.repeat(201) }]) {
                expect((await invoice(adminId, body)).status, JSON.stringify(body)).toBe(400);
            }
            const draft = (await invoice(adminId, { transferId: t })).body;
            for (const patch of [{}, { lines: [] }, { lines: [{ skuId: sku.id, unitPrice: '-1' }] }, { lines: [{ skuId: sku.id, unitPrice: '1.005' }] }, { total: '5.00' }, { status: 'final' }, { lines: [{ skuId: randomUUID(), unitPrice: '1.00' }] }]) {
                expect((await request(app).patch(`/invoices/${draft.id}`).set(as(adminId)).send(patch)).status, JSON.stringify(patch)).toBe(400);
            }
            expect((await request(app).get('/invoices/abc').set(as(adminId))).status).toBe(404);
        });

        it('the supply invoice: the sending place only (admin, a manager who reaches the warehouse); not the receiving branch, not an employee', async () => {
            const a = await newSku('10.00');
            const transferId = await sentTransfer([{ skuId: a.id, quantity: 3 }]);
            expect((await invoice(staffId, { transferId })).status).toBe(403);                               // no permission
            expect((await invoice(hamraManagerId, { transferId })).status).toBe(403);                        // the receiving branch cannot make it
            expect((await invoice(tripoliManagerId, { transferId })).status).toBe(404);                      // a stranger: it does not exist for them
            expect((await request(app).post('/invoices').send({ transferId })).status).toBe(401);
            const draft = (await invoice(warehouseManagerId, { transferId })).body;
            const cannot = [['patch', { note: 'x' }], ['post', undefined, '/finalize'], ['post', { reason: 'Because' }, '/void'], ['delete', undefined]] as const;
            for (const [method, body, tail] of cannot) {
                for (const [who, expected] of [[hamraManagerId, 403], [tripoliManagerId, 404], [staffId, 403]] as const) {
                    const req = (request(app) as unknown as Record<string, (path: string) => request.Test>)[method](`/invoices/${draft.id}${tail ?? ''}`).set(as(who));
                    expect((await (body ? req.send(body) : req)).status, `${method} ${tail ?? ''} by ${who}`).toBe(expected);
                }
            }
        });

        it('who sees an invoice: the place that issued it, the place it is addressed to, the admin; a stranger gets 404', async () => {
            const a = await newSku('10.00');
            const transferId = await sentTransfer([{ skuId: a.id, quantity: 2 }]);
            const draft = (await invoice(adminId, { transferId })).body;
            for (const [who, status] of [[adminId, 200], [warehouseManagerId, 200], [hamraManagerId, 200], [staffId, 200], [tripoliManagerId, 404]] as const) {
                expect((await request(app).get(`/invoices/${draft.id}`).set(as(who))).status, `get by ${who}`).toBe(status);
                expect((await request(app).get(`/invoices/${draft.id}/pdf`).set(as(who))).status, `pdf by ${who}`).toBe(status);
            }
            expect((await request(app).get(`/invoices/${draft.id}`)).status).toBe(401);
        });
    });

    describe('the PDF and the list', () => {
        it('the PDF is a real file with the reference, the lines and the totals; a draft and a void one are marked', async () => {
            const a = await newSku('45.00');
            const transferId = await sentTransfer([{ skuId: a.id, quantity: 4 }]);
            const draft = (await invoice(adminId, { transferId, note: 'For the opening' })).body;
            const asDraft = await request(app).get(`/invoices/${draft.id}/pdf`).set(as(hamraManagerId)).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
            expect(asDraft.status).toBe(200);
            expect(asDraft.headers['content-type']).toBe('application/pdf');
            expect(asDraft.headers['content-disposition']).toMatch(/^inline; filename="draft-/);
            expect((asDraft.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
            await request(app).post(`/invoices/${draft.id}/finalize`).set(as(adminId));
            const final = (await request(app).get(`/invoices/${draft.id}`).set(as(adminId))).body;
            const asFinal = await request(app).get(`/invoices/${draft.id}/pdf`).set(as(adminId)).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
            expect(asFinal.headers['content-disposition']).toBe(`inline; filename="${final.reference}.pdf"`);
            expect((asFinal.body as Buffer).length).toBeGreaterThan(5000);
        });

        it('the list: newest first with the total; filters by kind, status, branch, text and day; each place sees its own', async () => {
            const a = await newSku('10.00');
            const transferId = await sentTransfer([{ skuId: a.id, quantity: 2 }]);
            const b2b = (await invoice(adminId, { transferId })).body;
            const c = await newSku('20.00');                                                                 // a product that Hamra has never had, to sell (the opening stock is for the first time only)
            const s = await sale(c.id, hamraId, 1);
            const b2c = (await invoice(adminId, { saleId: s.id, customerName: `Lister Customer ${stamp}` })).body;
            const all = await request(app).get('/invoices?limit=200').set(as(adminId));
            expect(all.status).toBe(200);
            expect(Number(all.headers['x-total-count'])).toBeGreaterThanOrEqual(2);
            const ids = all.body.map((i: { id: string }) => i.id);
            expect(ids.indexOf(b2c.id)).toBeLessThan(ids.indexOf(b2b.id));                                  // newest first
            expect(all.body[0]).toMatchObject({ lineCount: expect.any(Number) });
            expect(all.body[0].lines).toBeUndefined();                                                       // a summary
            expect((await request(app).get(`/invoices?kind=b2c&search=lister%20customer%20${stamp}`).set(as(adminId))).body.map((i: { id: string }) => i.id)).toEqual([b2c.id]);
            expect((await request(app).get(`/invoices?status=draft&branchId=${hamraId}&kind=b2b`).set(as(adminId))).body.map((i: { id: string }) => i.id)).toContain(b2b.id);
            expect((await request(app).get(`/invoices?search=${s.reference}`).set(as(adminId))).body.map((i: { id: string }) => i.id)).toContain(b2c.id);          // by the sale number
            expect((await request(app).get('/invoices?from=2020-01-01&to=2020-01-31').set(as(adminId))).body).toEqual([]);
            const page = await request(app).get('/invoices?limit=1&offset=1').set(as(adminId));
            expect([page.body.length]).toEqual([1]);
            const hamra = await request(app).get('/invoices?limit=200').set(as(hamraManagerId));
            expect(hamra.body.map((i: { id: string }) => i.id)).toEqual(expect.arrayContaining([b2b.id, b2c.id]));        // addressed to Hamra, issued by Hamra
            const tripoli = await request(app).get('/invoices?limit=200').set(as(tripoliManagerId));
            expect(tripoli.body.map((i: { id: string }) => i.id)).not.toContain(b2b.id);
            expect((await request(app).get(`/invoices?branchId=${hamraId}`).set(as(tripoliManagerId))).status).toBe(403);
            expect((await request(app).get('/invoices')).status).toBe(401);
            for (const q of ['kind=b3b', 'status=paid', 'branchId=abc', 'from=2026-02-30', 'from=2026-11-01&to=2026-10-01', 'limit=0', 'offset=-1', 'search=']) expect((await request(app).get(`/invoices?${q}`).set(as(adminId))).status, q).toBe(400);
        });
    });

    describe('races', () => {
        it('the invoice of the same transfer made by 4 people at once: exactly one', async () => {
            const a = await newSku('10.00');
            const transferId = await sentTransfer([{ skuId: a.id, quantity: 2 }]);
            const results = await Promise.all(Array.from({ length: 4 }, () => invoice(adminId, { transferId })));
            expect(results.filter((r) => r.status === 201)).toHaveLength(1);
            expect(results.filter((r) => r.status === 409)).toHaveLength(3);
        });

        it('finalized twice at once: one number, one wins', async () => {
            const a = await newSku('10.00');
            const transferId = await sentTransfer([{ skuId: a.id, quantity: 2 }]);
            const draft = (await invoice(adminId, { transferId })).body;
            const results = await Promise.all([1, 2, 3].map(() => request(app).post(`/invoices/${draft.id}/finalize`).set(as(adminId))));
            expect(results.filter((r) => r.status === 200)).toHaveLength(1);
            expect(results.filter((r) => r.status === 409)).toHaveLength(2);
        });

        it('the numbers never repeat', async () => {
            const refs = await prisma.$queryRaw<{ reference: string; n: number }[]>`SELECT reference, COUNT(*)::int AS n FROM invoices WHERE reference IS NOT NULL GROUP BY reference HAVING COUNT(*) > 1`;
            expect(refs).toEqual([]);
        });
    });
});
