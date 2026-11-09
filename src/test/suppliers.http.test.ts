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

// The suppliers are real records (BL-06): a name and a phone number, kept by managers, linked from every goods receipt.
const disposable = process.env.TEST_DB_DISPOSABLE === '1';
const stamp = Date.now();
const tokens = new JwtTokenService(process.env.JWT_SECRET!);
const as = (id: string) => ({ Authorization: `Bearer ${tokens.sign(id)}` });
const key = () => `sup-${randomUUID()}`;

let adminId = '', managerId = '', branchManagerId = '', staffId = '', warehouseId = '', branchId = '', skuId = '';
let counter = 0;
const make = async (tag: string, role: UserRole) => (await createUserWithPassword(new UserRepository(prisma), { email: `${tag}-${stamp}@bitar.test`, password: 'Password#123', fullName: `Test ${tag}`, role }, adminId)).getId();
const receive = (userId: string, body: object) => request(app).post('/goods-receipts').set(as(userId)).set('Idempotency-Key', key()).send({ lines: [{ skuId, quantity: 2, unitCost: '3.00' }], ...body });

describe.skipIf(!disposable)('suppliers (real database)', () => {
    beforeAll(async () => {
        await waitForDatabase(prisma);
        adminId = (await createUserWithPassword(new UserRepository(prisma), { email: `supadmin-${stamp}@bitar.test`, password: 'Password#123', fullName: 'Test supadmin', role: UserRole.ADMIN }, null)).getId();
        managerId = await make('supmgr', UserRole.MANAGER);
        branchManagerId = await make('supbm', UserRole.MANAGER);
        staffId = await make('supstaff', UserRole.EMPLOYEE);
        const all = await request(app).get('/branches').set(as(adminId));
        warehouseId = all.body.find((b: { kind: string }) => b.kind === 'warehouse')?.id;
        if (!warehouseId) warehouseId = (await request(app).post('/branches').set(as(adminId)).send({ code: `SUW-${stamp}`, name: 'Main Warehouse (supplier test)', kind: 'warehouse' })).body.id;
        await request(app).patch(`/branches/${warehouseId}`).set(as(adminId)).send({ isActive: true });
        branchId = (await request(app).post('/branches').set(as(adminId)).send({ code: `SUB-${stamp}`, name: 'Supplier Test Branch' })).body.id;
        expect((await request(app).put(`/users/${managerId}/branches/${warehouseId}`).set(as(adminId))).status).toBe(204);
        expect((await request(app).put(`/users/${branchManagerId}/branches/${branchId}`).set(as(adminId))).status).toBe(204);
        expect((await request(app).put(`/users/${staffId}/branches/${branchId}`).set(as(adminId))).status).toBe(204);
        const styleId = (await request(app).post('/styles').set(as(adminId)).send({ code: `SUS${stamp}`, name: 'Supplier Test Dress' })).body.id;
        skuId = (await request(app).post('/skus').set(as(adminId)).send({ styleId, skuCode: `SU${stamp}-1`, size: 'M', color: 'Grey', standardPrice: '10.00' })).body.id;
    }, 120_000);

    it('a manager keeps suppliers: a name and a phone number, and changing the phone keeps what was received', async () => {
        const name = `Textile House ${stamp}`;
        const created = await request(app).post('/suppliers').set(as(managerId)).send({ name: `  ${name}  `, phone: '+961 3 123 456', note: 'Phone orders' });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        expect(created.body).toMatchObject({ name, phone: '+961 3 123 456', note: 'Phone orders', isActive: true, receiptCount: 0 });
        const id = created.body.id;
        const first = await receive(managerId, { supplierId: id, supplierInvoiceNumber: 'H-1' });
        expect(first.status, JSON.stringify(first.body)).toBe(201);
        expect(first.body).toMatchObject({ supplierName: name, supplier: { id, phone: '+961 3 123 456' } });
        const changed = await request(app).patch(`/suppliers/${id}`).set(as(adminId)).send({ phone: '+961 70 999 888', name: `${name} Ltd` });
        expect(changed.body).toMatchObject({ name: `${name} Ltd`, phone: '+961 70 999 888', receiptCount: 1 });
        const reread = (await request(app).get(`/goods-receipts/${first.body.id}`).set(as(adminId))).body;
        expect(reread).toMatchObject({ supplierName: name, supplier: { id, phone: '+961 70 999 888' } });           // the same receipt: the name of the day, the phone now
        expect((await request(app).get(`/goods-receipts?supplierId=${id}`).set(as(adminId))).body.map((r: { id: string }) => r.id)).toEqual([first.body.id]);
        const audit = await request(app).get(`/audit-events?entityType=supplier&entityId=${id}`).set(as(adminId));
        expect(audit.body.map((e: { action: string }) => e.action).sort()).toEqual(['supplier.create', 'supplier.update']);
    });

    it('the list and the search; deactivating keeps the supplier and its receipts but stops new deliveries', async () => {
        const name = `Silk Route ${stamp}`;
        const id = (await request(app).post('/suppliers').set(as(adminId)).send({ name, phone: '01 234 567' })).body.id;
        const list = await request(app).get(`/suppliers?search=silk%20route%20${stamp}`).set(as(adminId));
        expect(list.status).toBe(200);
        expect(list.body.map((s: { id: string }) => s.id)).toEqual([id]);
        expect(Number(list.headers['x-total-count'])).toBe(1);
        expect((await request(app).get('/suppliers?search=01%20234').set(as(adminId))).body.map((s: { id: string }) => s.id)).toContain(id);
        expect((await request(app).get('/suppliers?limit=1&offset=1').set(as(adminId))).body).toHaveLength(1);
        await receive(adminId, { supplierId: id });
        expect((await request(app).patch(`/suppliers/${id}`).set(as(managerId)).send({ isActive: false })).body.isActive).toBe(false);
        const refused = await receive(adminId, { supplierId: id });
        expect(refused.status).toBe(409);
        expect(refused.body.message).toMatch(/inactive/);
        expect((await receive(adminId, { supplierName: name.toUpperCase() })).status).toBe(409);                  // found by name: still inactive
        expect((await request(app).get(`/suppliers?search=silk%20route%20${stamp}&active=true`).set(as(adminId))).body).toEqual([]);
        expect((await request(app).get(`/suppliers?search=silk%20route%20${stamp}&active=false`).set(as(adminId))).body.map((s: { id: string }) => s.id)).toEqual([id]);
        expect((await request(app).patch(`/suppliers/${id}`).set(as(managerId)).send({ isActive: true })).status).toBe(200);
        expect((await receive(adminId, { supplierId: id })).status).toBe(201);
    });

    it('the same name twice (any letter case) is refused; a bad body is a 400', async () => {
        const name = `Unique Name ${stamp}`;
        expect((await request(app).post('/suppliers').set(as(adminId)).send({ name, phone: '03 111 222' })).status).toBe(201);
        const again = await request(app).post('/suppliers').set(as(adminId)).send({ name: name.toUpperCase(), phone: '03 111 333' });
        expect(again.status).toBe(409);
        const other = (await request(app).post('/suppliers').set(as(adminId)).send({ name: `Other Name ${stamp}`, phone: '03 111 444' })).body.id;
        expect((await request(app).patch(`/suppliers/${other}`).set(as(adminId)).send({ name: name.toLowerCase() })).status).toBe(409);
        for (const body of [{}, { name: 'X', phone: '03 111 222' }, { name: 'Good Name', phone: '12' }, { name: 'Good Name', phone: 'call me' }, { name: 'Good Name' }, { phone: '03 111 222' }, { name: 'Good Name', phone: '03 111 222', note: 'x'.repeat(201) }, { name: 5, phone: '03 111 222' }]) {
            expect((await request(app).post('/suppliers').set(as(adminId)).send(body)).status, JSON.stringify(body)).toBe(400);
        }
        for (const body of [{}, { name: 'X' }, { phone: '1' }, { isActive: 'yes' }, { note: 'x'.repeat(201) }, { code: 'A-1' }]) {
            expect((await request(app).patch(`/suppliers/${other}`).set(as(adminId)).send(body)).status, JSON.stringify(body)).toBe(400);
        }
        expect((await request(app).get('/suppliers/abc').set(as(adminId))).status).toBe(404);
        expect((await request(app).get(`/suppliers/${randomUUID()}`).set(as(adminId))).status).toBe(404);
        expect((await request(app).patch(`/suppliers/${randomUUID()}`).set(as(adminId)).send({ note: 'x' })).status).toBe(404);
        for (const q of ['active=maybe', 'limit=0', 'offset=-1', 'search=']) expect((await request(app).get(`/suppliers?${q}`).set(as(adminId))).status, q).toBe(400);
        expect((await request(app).get('/suppliers')).status).toBe(401);
    });

    it('only an admin or a manager manages suppliers: an employee and a branch user cannot even list them', async () => {
        for (const who of [staffId]) {
            expect((await request(app).get('/suppliers').set(as(who))).status).toBe(403);
            expect((await request(app).post('/suppliers').set(as(who)).send({ name: `Nope ${stamp}`, phone: '03 000 000' })).status).toBe(403);
        }
        const id = (await request(app).post('/suppliers').set(as(managerId)).send({ name: `Manager Made ${stamp}`, phone: '03 222 333' })).body.id;
        expect((await request(app).patch(`/suppliers/${id}`).set(as(staffId)).send({ note: 'x' })).status).toBe(403);
        expect((await request(app).get(`/suppliers/${id}`).set(as(staffId))).status).toBe(403);
    });

    it('a delivery names a supplier: an existing one is found by name; a manager\'s delivery adds a new one once, even when several come at the same moment', async () => {
        const name = `Brand New ${stamp}`;
        const results = await Promise.all(Array.from({ length: 4 }, (_, i) => receive(adminId, { supplierName: name, supplierInvoiceNumber: `BN-${i}` })));
        expect(results.map((r) => r.status), JSON.stringify(results.map((r) => r.body))).toEqual([201, 201, 201, 201]);
        const found = (await request(app).get(`/suppliers?search=${encodeURIComponent(name)}`).set(as(adminId))).body;
        expect(found).toHaveLength(1);                                                                      // one supplier, not four
        expect(found[0].receiptCount).toBe(4);
        const byName = await receive(adminId, { supplierName: `  ${name.toUpperCase()}  `, supplierInvoiceNumber: 'BN-9' });
        expect(byName.status).toBe(201);
        expect(byName.body.supplier.id).toBe(found[0].id);
        expect((await request(app).get(`/suppliers/${found[0].id}`).set(as(adminId))).body.receiptCount).toBe(5);
    });

    it('the supplier of a delivery: unknown id is 404; the invoice number is optional; when given it is unique per supplier (not across suppliers)', async () => {
        expect((await receive(adminId, { supplierId: randomUUID() })).status).toBe(404);
        expect((await receive(adminId, { supplierId: 'abc' })).status).toBe(400);
        expect((await receive(adminId, {})).status).toBe(400);                                              // neither a supplier id nor a name
        const a = (await request(app).post('/suppliers').set(as(adminId)).send({ name: `Opt A ${stamp}`, phone: '03 555 111' })).body.id;
        const b = (await request(app).post('/suppliers').set(as(adminId)).send({ name: `Opt B ${stamp}`, phone: '03 555 222' })).body.id;
        const noNumber = [await receive(adminId, { supplierId: a }), await receive(adminId, { supplierId: a, supplierInvoiceNumber: '' }), await receive(adminId, { supplierId: a, supplierInvoiceNumber: null })];
        expect(noNumber.map((r) => r.status)).toEqual([201, 201, 201]);
        expect(noNumber.every((r) => r.body.supplierInvoiceNumber === null)).toBe(true);
        const first = await receive(adminId, { supplierId: a, supplierInvoiceNumber: 'Z-1' });
        expect(first.status).toBe(201);
        const dup = await receive(adminId, { supplierId: a, supplierInvoiceNumber: ' z-1 ' });
        expect(dup.status).toBe(409);
        expect(dup.body.message).toBe(`This supplier invoice was already received as ${first.body.reference}`);
        expect((await receive(adminId, { supplierId: b, supplierInvoiceNumber: 'Z-1' })).status).toBe(201);
    });

    it('a delivery by someone who cannot add suppliers must name an existing one (the warehouse manager can add)', async () => {
        const name = `Existing Only ${stamp}`;
        const ok = await receive(managerId, { supplierName: name });                                        // a manager who reaches the warehouse: may add
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);
        expect((await receive(branchManagerId, { supplierName: name })).status).toBe(403);                  // a branch user does not reach the warehouse at all
        expect((await receive(staffId, { supplierName: name })).status).toBe(403);
    });
});
