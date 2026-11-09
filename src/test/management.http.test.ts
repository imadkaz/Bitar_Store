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

// Sales, stock movements and audit events can never be deleted: these tests run only on a database you can throw away (TEST_DB_DISPOSABLE=1).
const disposable = process.env.TEST_DB_DISPOSABLE === '1';

const stamp = Date.now();
const tokens = new JwtTokenService(process.env.JWT_SECRET!);
const as = (id: string) => ({ Authorization: `Bearer ${tokens.sign(id)}` });
const key = () => `mg-${randomUUID()}`;
const today = businessDateOf(new Date());

let adminId = '', managerId = '', staffId = '', staff2Id = '';
let hamraId = '', tripoliId = '', warehouseId = '';
let counter = 0;

const newCategory = (userId: string, name: string) => request(app).post('/categories').set(as(userId)).send({ name });
const newStyle = async (category?: string) => {
    const res = await request(app).post('/styles').set(as(managerId)).send({ code: `MG${stamp}-${++counter}`, name: `Management Test ${counter}`, ...(category ? { category } : {}) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
};
const newSku = async (styleId: string, price = '20.00') => {
    const res = await request(app).post('/skus').set(as(managerId)).send({ styleId, skuCode: `MGS${stamp}-${++counter}`, size: `S${counter}`, color: 'Grey', standardPrice: price });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; skuCode: string };
};
const open = async (skuId: string, branchId: string, quantity: number) => {
    const res = await request(app).post('/stock/opening').set(as(adminId)).set('Idempotency-Key', key()).send({ branchId, lines: [{ skuId, quantity }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
};
const sell = (userId: string, branchId: string, skuId: string, quantity: number, whish = false) =>
    request(app).post('/sales').set(as(userId)).set('Idempotency-Key', key()).send({
        branchId, lines: [{ skuId, quantity }],
        payments: whish ? [{ method: 'cash', amount: '10.00' }, { method: 'whish', amount: (20 * quantity - 10).toFixed(2), reference: `MG-${stamp}-${++counter}` }] : [{ method: 'cash', amount: (20 * quantity).toFixed(2) }],
    });
const make = async (tag: string, role: UserRole) => (await createUserWithPassword(new UserRepository(prisma), { email: `${tag}-${stamp}@bitar.test`, password: 'Password#123', fullName: `Test ${tag}`, role }, adminId)).getId();

describe.skipIf(!disposable)('what the owner manages (real database)', () => {
    beforeAll(async () => {
        await waitForDatabase(prisma);
        adminId = (await createUserWithPassword(new UserRepository(prisma), { email: `mgadmin-${stamp}@bitar.test`, password: 'Password#123', fullName: 'Test mgadmin', role: UserRole.ADMIN }, null)).getId();
        managerId = await make('mgm', UserRole.MANAGER);
        staffId = await make('mgs', UserRole.EMPLOYEE);
        staff2Id = await make('mgs2', UserRole.EMPLOYEE);
        hamraId = (await request(app).post('/branches').set(as(adminId)).send({ code: `MGH-${stamp}`, name: 'Hamra (management test)' })).body.id;
        tripoliId = (await request(app).post('/branches').set(as(adminId)).send({ code: `MGT-${stamp}`, name: 'Tripoli (management test)' })).body.id;
        for (const [user, branch] of [[managerId, hamraId], [staffId, hamraId], [staff2Id, tripoliId]]) expect((await request(app).put(`/users/${user}/branches/${branch}`).set(as(adminId))).status).toBe(204);
        const all = await request(app).get('/branches').set(as(adminId));
        warehouseId = all.body.find((b: { kind: string }) => b.kind === 'warehouse')?.id;
        if (!warehouseId) warehouseId = (await request(app).post('/branches').set(as(adminId)).send({ code: `MGW-${stamp}`, name: 'Main Warehouse (test)', kind: 'warehouse' })).body.id;
        await request(app).patch(`/branches/${warehouseId}`).set(as(adminId)).send({ isActive: true });   // an earlier test may have left the one and only warehouse inactive
    }, 120_000);

    describe('categories', () => {
        it('the owner adds a category; the same name in another case is refused; anyone reads the list, only the catalog people change it', async () => {
            const name = `MG Dresses ${stamp}`;
            const created = await newCategory(managerId, name);
            expect(created.status, JSON.stringify(created.body)).toBe(201);
            expect(created.body).toMatchObject({ name, isActive: true, productCount: 0 });
            expect((await newCategory(adminId, name.toLowerCase())).status).toBe(409);
            expect((await newCategory(staffId, `Nope ${stamp}`)).status).toBe(403);
            const list = await request(app).get('/categories').set(as(staffId));
            expect(list.status).toBe(200);
            expect(list.body.map((c: { name: string }) => c.name)).toContain(name);
            expect((await request(app).get('/categories')).status).toBe(401);
            for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(61) }, { name: 5 }]) expect((await request(app).post('/categories').set(as(adminId)).send(body)).status, JSON.stringify(body)).toBe(400);
        });

        it('a product takes a category from the list; an unknown one is a clear 400; renaming follows; a category in use cannot be deleted', async () => {
            const name = `MG Tops ${stamp}`;
            const category = (await newCategory(adminId, name)).body;
            const style = await newStyle(name);
            expect((await request(app).get(`/styles/${style.id}`).set(as(staffId))).body.category).toBe(name);
            expect((await request(app).get('/categories').set(as(adminId))).body.find((c: { id: string }) => c.id === category.id).productCount).toBe(1);

            const unknown = await request(app).post('/styles').set(as(managerId)).send({ code: `MGU${stamp}`, name: 'Unknown category', category: `Not in the list ${stamp}` });
            expect(unknown.status).toBe(400);
            expect(unknown.body.message).toBe('This category does not exist: add it in Categories first');
            expect((await request(app).patch(`/styles/${style.id}`).set(as(managerId)).send({ category: `Not in the list ${stamp}` })).status).toBe(400);

            const renamed = await request(app).patch(`/categories/${category.id}`).set(as(managerId)).send({ name: `MG T-Shirts ${stamp}` });
            expect(renamed.status).toBe(200);
            expect((await request(app).get(`/styles/${style.id}`).set(as(staffId))).body.category).toBe(`MG T-Shirts ${stamp}`);       // the product followed

            const blocked = await request(app).delete(`/categories/${category.id}`).set(as(managerId));
            expect(blocked.status).toBe(409);
            expect(blocked.body.message).toMatch(/1 product\(s\) use this category/);
            expect((await request(app).patch(`/categories/${category.id}`).set(as(managerId)).send({ isActive: false })).body.isActive).toBe(false);
            expect((await request(app).patch(`/styles/${style.id}`).set(as(managerId)).send({ category: null })).status).toBe(200);
            expect((await request(app).delete(`/categories/${category.id}`).set(as(staffId))).status).toBe(403);
            expect((await request(app).delete(`/categories/${category.id}`).set(as(managerId))).status).toBe(204);
            expect((await request(app).delete(`/categories/${category.id}`).set(as(managerId))).status).toBe(404);
            for (const [id, body] of [[category.id, {}], [category.id, { code: 'x' }], [category.id, { isActive: 'yes' }], ['abc', { name: 'x' }]] as const) {
                const res = await request(app).patch(`/categories/${id}`).set(as(managerId)).send(body);
                expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
            }
        });
    });

    describe('deleting products', () => {
        it('a product that never sold is deleted with its skus, barcodes and price history; one with history is refused and can be archived', async () => {
            const style = await newStyle();
            const a = await newSku(style.id);
            const b = await newSku(style.id);
            expect((await request(app).post(`/skus/${a.id}/barcodes`).set(as(managerId)).send({ code: `40063813${String(stamp).slice(-5)}` })).status).toBeLessThan(500);
            await request(app).put(`/skus/${a.id}/price`).set(as(managerId)).send({ price: '25.00' });

            expect((await request(app).delete(`/skus/${b.id}`).set(as(staffId))).status).toBe(403);
            expect((await request(app).delete(`/skus/${b.id}`).set(as(managerId))).status).toBe(204);
            expect((await request(app).get(`/skus/${b.id}`).set(as(managerId))).status).toBe(404);

            await open(a.id, hamraId, 3);                                                          // now one sku has history
            const refused = await request(app).delete(`/styles/${style.id}`).set(as(managerId));
            expect(refused.status).toBe(409);
            expect(refused.body.message).toMatch(/archive it instead/);
            expect((await request(app).get(`/skus/${a.id}`).set(as(managerId))).status).toBe(200);          // nothing was deleted (the transaction is undone)
            expect((await request(app).delete(`/skus/${a.id}`).set(as(managerId))).status).toBe(409);
            expect((await request(app).patch(`/skus/${a.id}`).set(as(managerId)).send({ isActive: false })).body.isActive).toBe(false);      // archived instead

            const clean = await newStyle();
            const s1 = await newSku(clean.id);
            await newSku(clean.id);
            expect((await request(app).delete(`/styles/${clean.id}`).set(as(managerId))).status).toBe(204);
            expect((await request(app).get(`/styles/${clean.id}`).set(as(managerId))).status).toBe(404);
            expect((await request(app).get(`/skus/${s1.id}`).set(as(managerId))).status).toBe(404);
            expect(await prisma.skuPriceHistory.count({ where: { skuId: s1.id } })).toBe(0);
            for (const path of [`/styles/${randomUUID()}`, `/skus/${randomUUID()}`, '/styles/abc', '/skus/abc']) expect((await request(app).delete(path).set(as(managerId))).status, path).toBe(404);
            expect((await request(app).delete(`/styles/${clean.id}`)).status).toBe(401);
        });

        it('the delete is recorded: who removed which product', async () => {
            const style = await newStyle();
            await request(app).delete(`/styles/${style.id}`).set(as(managerId));
            const audit = await request(app).get(`/audit-events?entityType=style&entityId=${style.id}`).set(as(adminId));
            expect(audit.body[0]).toMatchObject({ action: 'style.delete', by: { id: managerId } });
        });
    });

    describe('deleting branches', () => {
        it('a new branch is deleted; one with sales, stock or recorded changes is refused (deactivate it); only the admin', async () => {
            const fresh = (await request(app).post('/branches').set(as(adminId)).send({ code: `MGD-${stamp}`, name: 'To delete' })).body.id;
            await request(app).put(`/users/${staff2Id}/branches/${fresh}`).set(as(adminId));
            expect((await request(app).delete(`/branches/${fresh}`).set(as(managerId))).status).toBe(403);
            expect((await request(app).delete(`/branches/${fresh}`).set(as(adminId))).status).toBe(204);
            expect((await request(app).get('/branches').set(as(adminId))).body.map((b: { id: string }) => b.id)).not.toContain(fresh);
            expect((await request(app).delete(`/branches/${fresh}`).set(as(adminId))).status).toBe(404);
            expect((await request(app).delete('/branches/abc').set(as(adminId))).status).toBe(404);

            const sku = await newSku((await newStyle()).id);
            await open(sku.id, hamraId, 5);
            const used = await request(app).delete(`/branches/${hamraId}`).set(as(adminId));
            expect(used.status).toBe(409);
            expect(used.body.message).toMatch(/deactivate it instead/);
            await open(sku.id, warehouseId, 2);                                                       // the warehouse has history only once something moved there (on a fresh database it has none)
            expect((await request(app).delete(`/branches/${warehouseId}`).set(as(adminId))).status).toBe(409);

            const renamed = (await request(app).post('/branches').set(as(adminId)).send({ code: `MGR-${stamp}`, name: 'Renamed' })).body.id;
            await request(app).patch(`/branches/${renamed}`).set(as(adminId)).send({ name: 'Renamed once' });
            expect((await request(app).delete(`/branches/${renamed}`).set(as(adminId))).status).toBe(409);                  // a recorded change is history too
            expect((await request(app).patch(`/branches/${renamed}`).set(as(adminId)).send({ isActive: false })).body.isActive).toBe(false);
        });
    });

    describe('deleting a user: they disappear, what they did stays', () => {
        it('gone from the list, cannot log in, the email is free again, and their sales still show their name', async () => {
            const email = `gone-${stamp}@bitar.test`;
            const created = await request(app).post('/users').set(as(adminId)).send({ email, fullName: 'Gone Cashier', role: 'employee' });
            expect(created.status).toBe(201);
            const id = created.body.id;
            await request(app).put(`/users/${id}/password`).set(as(adminId)).send({ password: 'Gone#Password1' });
            await request(app).put(`/users/${id}/branches/${hamraId}`).set(as(adminId));
            expect((await request(app).post('/auth/login').send({ email, password: 'Gone#Password1' })).status).toBe(200);

            const sku = await newSku((await newStyle()).id);
            await open(sku.id, hamraId, 5);
            const sale = await sell(id, hamraId, sku.id, 1);
            expect(sale.status, JSON.stringify(sale.body)).toBe(201);

            expect((await request(app).delete(`/users/${id}`).set(as(managerId))).status).toBe(403);
            expect((await request(app).delete(`/users/${adminId}`).set(as(adminId))).status).toBe(409);                    // not yourself
            expect((await request(app).delete(`/users/${id}`).set(as(adminId))).status).toBe(204);
            expect((await request(app).get('/users').set(as(adminId))).body.map((u: { id: string }) => u.id)).not.toContain(id);
            expect((await request(app).post('/auth/login').send({ email, password: 'Gone#Password1' })).status).toBe(401);
            expect((await request(app).get('/auth/me').set(as(id))).status).toBe(401);                                    // the token they still hold is useless

            const history = await request(app).get(`/sales/history?branchId=${hamraId}`).set(as(adminId));
            const row = history.body.sales.find((s: { id: string }) => s.id === sale.body.id);
            expect(row.soldBy).toMatchObject({ id, name: 'Gone Cashier' });                                                  // the sale kept who made it
            expect(await prisma.stockMovement.count({ where: { actorUserId: id } })).toBeGreaterThan(0);                    // and so did the ledger
            expect(await prisma.userBranchAccess.count({ where: { userId: id } })).toBe(0);

            expect((await request(app).post('/users').set(as(adminId)).send({ email, fullName: 'Gone Cashier Again', role: 'employee' })).status).toBe(201);   // the email is free
            expect((await request(app).delete(`/users/${id}`).set(as(adminId))).status).toBe(404);                         // already gone
            const audit = await request(app).get(`/audit-events?entityType=user&entityId=${id}`).set(as(adminId));
            expect(audit.body[0]).toMatchObject({ action: 'user.delete', details: { email, fullName: 'Gone Cashier', role: 'employee' } });
            expect((await request(app).delete('/users/abc').set(as(adminId))).status).toBe(404);
        });
    });

    describe('sales history', () => {
        let skuId = '';

        beforeAll(async () => {
            skuId = (await newSku((await newStyle()).id)).id;
            await open(skuId, hamraId, 20);
            await open(skuId, tripoliId, 20);
            for (const res of [await sell(staffId, hamraId, skuId, 2, true), await sell(staffId, hamraId, skuId, 1), await sell(staff2Id, tripoliId, skuId, 3)]) expect(res.status, JSON.stringify(res.body)).toBe(201);
        }, 60_000);

        it('the sales of a period for a branch: newest first, with the seller, the items and the cash and Whish split', async () => {
            const res = await request(app).get(`/sales/history?branchId=${hamraId}`).set(as(managerId));
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect([res.body.from, res.body.to]).toEqual([today, today]);
            expect(Number(res.headers['x-total-count'])).toBe(res.body.sales.length);        // the total is the whole list (fewer than one page here)
            const mine = res.body.sales.filter((s: { branch: { id: string } }) => s.branch.id === hamraId);
            expect(mine).toHaveLength(res.body.sales.length);
            const two = res.body.sales.find((s: { items: number; whish: string }) => s.items === 2);
            expect(two).toMatchObject({ total: '40.00', cash: '10.00', whish: '30.00', discounts: '0.00', status: 'completed', channel: 'in_store', soldBy: { id: staffId, name: 'Test mgs' }, businessDate: today });
            const stamps = res.body.sales.map((s: { soldAt: string }) => s.soldAt);
            expect([...stamps].sort().reverse()).toEqual(stamps);
        });

        it('who sees what: the admin every branch, a manager and an employee only their own', async () => {
            const all = await request(app).get('/sales/history?limit=200').set(as(adminId));
            const branches = new Set(all.body.sales.map((s: { branch: { id: string } }) => s.branch.id));
            expect(branches.has(hamraId) && branches.has(tripoliId)).toBe(true);
            const mgr = await request(app).get('/sales/history?limit=200').set(as(managerId));
            expect(mgr.body.sales.every((s: { branch: { id: string } }) => s.branch.id === hamraId)).toBe(true);
            expect((await request(app).get(`/sales/history?branchId=${tripoliId}`).set(as(managerId))).status).toBe(403);
            expect((await request(app).get(`/sales/history?branchId=${hamraId}`).set(as(staff2Id))).status).toBe(403);
            expect((await request(app).get(`/sales/history?branchId=${tripoliId}`).set(as(staff2Id))).body.sales).toHaveLength(1);
            expect((await request(app).get('/sales/history')).status).toBe(401);
        });

        it('any period: a range, last year, yesterday is empty; paging with the total; bad input is a 400', async () => {
            const yearAgo = businessDateOf(new Date(Date.now() - 360 * 86_400_000));
            const year = await request(app).get(`/sales/history?branchId=${hamraId}&from=${yearAgo}&to=${today}`).set(as(managerId));
            expect(year.body.sales.length).toBeGreaterThanOrEqual(2);
            const old = await request(app).get(`/sales/history?branchId=${hamraId}&from=2020-01-01&to=2020-01-31`).set(as(managerId));
            expect(old.body.sales).toEqual([]);
            expect(old.headers['x-total-count']).toBe('0');
            const page = await request(app).get(`/sales/history?branchId=${hamraId}&limit=1&offset=1`).set(as(managerId));
            expect(page.body.sales).toHaveLength(1);
            expect(Number(page.headers['x-total-count'])).toBeGreaterThanOrEqual(2);
            for (const q of ['from=2026-02-30', 'to=today', 'from=2026-10-29&to=2026-10-01', 'from=2024-01-01&to=2026-10-29', 'branchId=abc', 'limit=0', 'limit=201', 'offset=-1']) {
                expect((await request(app).get(`/sales/history?${q}`).set(as(adminId))).status, q).toBe(400);
            }
        });
    });


    describe('permissions of one user', () => {
        const permissionsOf = (userId: string, as_ = adminId) => request(app).get(`/users/${userId}/permissions`).set(as(as_));
        const setPermissions = (userId: string, permissions: unknown, as_ = adminId) => request(app).put(`/users/${userId}/permissions`).set(as(as_)).send({ permissions });
        const allowedKeys = (body: { permissions: { key: string; allowed: boolean }[] }) => body.permissions.filter((p) => p.allowed).map((p) => p.key);
        const createProduct = (userId: string) => request(app).post('/styles').set(as(userId)).send({ code: `PM${stamp}-${++counter}`, name: 'Created by a permission' });

        it('the screen gets every permission with its words, and what each role has by default', async () => {
            const res = await request(app).get('/permissions').set(as(adminId));
            expect(res.status).toBe(200);
            expect(res.body.permissions).toHaveLength(13);                       // the nine of before and the four of the cash drawer
            for (const key of ['cash.open', 'cash.accept', 'cash.close', 'cash.move']) expect(res.body.permissions.find((p: { key: string }) => p.key === key)).toMatchObject({ grantable: true });
            expect(res.body.roles.employee).not.toEqual(expect.arrayContaining(['cash.open']));          // an employee gets none of them by default: they are granted
            expect(res.body.roles.manager).toEqual(expect.arrayContaining(['cash.open', 'cash.accept', 'cash.close', 'cash.move']));
            expect(res.body.permissions.find((p: { key: string }) => p.key === 'catalog.create')).toMatchObject({ label: 'Manage products', grantable: true });
            expect(res.body.permissions.find((p: { key: string }) => p.key === 'users.administer').grantable).toBe(false);
            expect(res.body.roles.employee).toEqual(['sales.create']);             // confirming an arrival is a manager's act: an employee receives only when it is granted (BL-03)
            expect(res.body.roles.manager).toContain('catalog.create');
            expect((await request(app).get('/permissions').set(as(managerId))).status).toBe(200);          // a manager reads it too (to hand on what they have)
            expect((await request(app).get('/permissions').set(as(staffId))).status).toBe(403);
            expect((await request(app).get('/permissions')).status).toBe(401);
        });

        it('an employee who may create products: the admin ticks it, and it works on their very next request; unticking takes it back', async () => {
            const employeeId = await make('pmemp', UserRole.EMPLOYEE);
            const before = await permissionsOf(employeeId);
            expect(allowedKeys(before.body)).toEqual(['sales.create']);
            expect(before.body.permissions.find((p: { key: string }) => p.key === 'catalog.create')).toMatchObject({ allowed: false, source: 'none' });
            expect((await createProduct(employeeId)).status).toBe(403);

            const granted = await setPermissions(employeeId, { 'catalog.create': true });
            expect(granted.status, JSON.stringify(granted.body)).toBe(200);
            expect(granted.body.permissions.find((p: { key: string }) => p.key === 'catalog.create')).toMatchObject({ allowed: true, source: 'granted' });
            expect(granted.body.overrides).toEqual([{ permission: 'catalog.create', effect: 'allow' }]);
            expect((await createProduct(employeeId)).status).toBe(201);                              // same token, no new login

            expect((await setPermissions(employeeId, { 'catalog.create': false })).body.overrides).toEqual([]);      // back to the role: no override is left behind
            expect(await prisma.userPermissionOverride.count({ where: { userId: employeeId } })).toBe(0);
            expect((await createProduct(employeeId)).status).toBe(403);
        });

        it('taking one away from a manager: no discounts for them, the rest unchanged', async () => {
            const mgr = await make('pmmgr', UserRole.MANAGER);
            await request(app).put(`/users/${mgr}/branches/${hamraId}`).set(as(adminId));
            const sku = await newSku((await newStyle()).id);
            await open(sku.id, hamraId, 10);
            const sale = (discount: boolean) => request(app).post('/sales').set(as(mgr)).set('Idempotency-Key', key()).send({
                branchId: hamraId, lines: [{ skuId: sku.id, quantity: 1, ...(discount ? { discount: { type: 'percent', percent: '10', reason: 'loyal customer' } } : {}) }], payments: [{ method: 'cash', amount: discount ? '18.00' : '20.00' }],
            });
            expect((await sale(true)).status).toBe(201);
            await setPermissions(mgr, { 'discounts.apply': false });
            expect((await sale(true)).status).toBe(403);
            expect((await sale(false)).status).toBe(201);
            const after = await permissionsOf(mgr);
            expect(after.body.permissions.find((p: { key: string }) => p.key === 'discounts.apply')).toMatchObject({ allowed: false, source: 'denied' });
            expect(after.body.permissions.find((p: { key: string }) => p.key === 'catalog.create')).toMatchObject({ allowed: true, source: 'role' });
        });

        it('create the user, then give the permissions: the two calls the new-user screen makes', async () => {
            const email = `pmnew-${stamp}@bitar.test`;
            const created = await request(app).post('/users').set(as(adminId)).send({ email, fullName: 'New Storekeeper', role: 'employee' });
            expect(created.status).toBe(201);
            const set = await setPermissions(created.body.id, { 'catalog.create': true, 'adjustments.create': true, 'sales.create': false });
            expect(set.status, JSON.stringify(set.body)).toBe(200);
            expect(allowedKeys(set.body)).toEqual(['catalog.create', 'adjustments.create']);       // in the order of the list, sales.create is gone
            expect(set.body.overrides).toHaveLength(3);
        });

        it('an employee never; a manager only for their own employees; never your own, never an admin, never the admin-only permission; every bad body is a 400', async () => {
            const target = await make('pmbad', UserRole.EMPLOYEE);
            expect((await setPermissions(target, { 'catalog.create': true }, managerId)).status).toBe(404);     // an employee that is not at the manager's branches does not exist for them
            expect((await permissionsOf(target, managerId)).status).toBe(404);
            expect((await setPermissions(target, { 'catalog.create': true }, staffId)).status).toBe(403);
            expect((await request(app).put(`/users/${target}/permissions`).send({ permissions: { 'catalog.create': true } })).status).toBe(401);
            expect((await setPermissions(adminId, { 'catalog.create': true })).status).toBe(409);               // not your own
            const another = await make('pmadm', UserRole.ADMIN);
            const onAdmin = await setPermissions(another, { 'catalog.create': false });
            expect(onAdmin.status).toBe(409);
            expect(onAdmin.body.message).toMatch(/change the role instead/);
            for (const permissions of [{ 'users.administer': true }, { 'nope.create': true }, { 'catalog.create': 'yes' }, { 'catalog.create': 1 }, {}, null, [], 'x']) {
                expect((await setPermissions(target, permissions)).status, JSON.stringify(permissions)).toBe(400);
            }
            expect((await request(app).put(`/users/${target}/permissions`).set(as(adminId)).send({})).status).toBe(400);
            expect((await request(app).put(`/users/${target}/permissions`).set(as(adminId))).status).toBe(400);
            expect((await setPermissions(randomUUID(), { 'catalog.create': true })).status).toBe(404);
            expect((await permissionsOf('abc')).status).toBe(404);
            expect(await prisma.userPermissionOverride.count({ where: { userId: target } })).toBe(0);            // none of the bad requests changed anything
        });

        it('a change is recorded with who did it and what the person could do before and after; asking for no change records nothing', async () => {
            const target = await make('pmaud', UserRole.EMPLOYEE);
            await setPermissions(target, { 'reports.financial': true });
            await setPermissions(target, { 'reports.financial': true });                                         // no change
            const audit = await request(app).get(`/audit-events?entityType=user&entityId=${target}`).set(as(adminId));
            const events = audit.body.filter((e: { action: string }) => e.action === 'user.permissions');
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({ by: { id: adminId }, details: { before: ['sales.create'], after: ['sales.create', 'reports.financial'] } });
        });

        it('a deleted user has no permissions to edit, and the ones they had go with them', async () => {
            const gone = await make('pmgone', UserRole.EMPLOYEE);
            await setPermissions(gone, { 'catalog.create': true });
            await request(app).delete(`/users/${gone}`).set(as(adminId));
            expect((await permissionsOf(gone)).status).toBe(404);
            expect(await prisma.userPermissionOverride.count({ where: { userId: gone } })).toBe(0);
        });
    });


    describe('a manager gives permissions to the employees of their own branches', () => {
        const permissionsOf = (userId: string, as_: string) => request(app).get(`/users/${userId}/permissions`).set(as(as_));
        const setPermissions = (userId: string, permissions: unknown, as_: string) => request(app).put(`/users/${userId}/permissions`).set(as(as_)).send({ permissions });
        const createProduct = (userId: string) => request(app).post('/styles').set(as(userId)).send({ code: `MP${stamp}-${++counter}`, name: 'Created by a permission' });

        it('the manager gives an employee of their branch the right to create products; it works at once, and the manager can take it back', async () => {
            const mgr = await make('mpm', UserRole.MANAGER);
            const emp = await make('mpe', UserRole.EMPLOYEE);
            for (const user of [mgr, emp]) await request(app).put(`/users/${user}/branches/${hamraId}`).set(as(adminId));
            expect((await createProduct(emp)).status).toBe(403);
            const given = await setPermissions(emp, { 'catalog.create': true }, mgr);
            expect(given.status, JSON.stringify(given.body)).toBe(200);
            expect(given.body.permissions.find((p: { key: string }) => p.key === 'catalog.create')).toMatchObject({ allowed: true, source: 'granted' });
            expect((await createProduct(emp)).status).toBe(201);
            expect((await permissionsOf(emp, mgr)).status).toBe(200);
            expect((await setPermissions(emp, { 'catalog.create': false }, mgr)).body.overrides).toEqual([]);
            expect((await createProduct(emp)).status).toBe(403);
            const audit = await request(app).get(`/audit-events?entityType=user&entityId=${emp}&actorId=${mgr}`).set(as(adminId));
            expect(audit.body.map((e: { action: string }) => e.action)).toEqual(['user.permissions', 'user.permissions']);       // who did it is on record: the manager
        });

        it('not for managers or admins, not for employees of other branches, never your own, and never a permission the manager does not have', async () => {
            const mgr = await make('mpm2', UserRole.MANAGER);
            await request(app).put(`/users/${mgr}/branches/${hamraId}`).set(as(adminId));
            const otherManager = await make('mpm3', UserRole.MANAGER);
            const admin2 = await make('mpa', UserRole.ADMIN);
            expect((await setPermissions(otherManager, { 'discounts.apply': false }, mgr)).status).toBe(403);       // a manager manages employees only
            expect((await setPermissions(admin2, { 'discounts.apply': false }, mgr)).status).toBe(403);
            expect((await setPermissions(mgr, { 'discounts.apply': false }, mgr)).status).toBe(409);                // not their own
            expect((await setPermissions(staff2Id, { 'catalog.create': true }, mgr)).status).toBe(404);             // an employee of Tripoli

            const emp = await make('mpe2', UserRole.EMPLOYEE);
            await request(app).put(`/users/${emp}/branches/${hamraId}`).set(as(adminId));
            await setPermissions(mgr, { 'reports.financial': false }, adminId);                                     // the admin takes reports away from this manager
            const denied = await setPermissions(emp, { 'reports.financial': true }, mgr);
            expect(denied.status).toBe(403);
            expect(denied.body.message).toMatch(/permission you do not have/);
            expect((await setPermissions(emp, { 'catalog.create': true }, mgr)).status).toBe(200);                  // one they have: fine
            expect((await setPermissions(emp, { 'users.administer': true }, mgr)).status).toBe(400);                // admin only, for everybody
            const catalog = await request(app).get('/permissions').set(as(mgr));
            expect(catalog.body.permissions.find((p: { key: string }) => p.key === 'reports.financial').grantable).toBe(false);
            expect(catalog.body.permissions.find((p: { key: string }) => p.key === 'catalog.create').grantable).toBe(true);
            expect(await prisma.userPermissionOverride.count({ where: { userId: emp, permission: 'reports.financial' } })).toBe(0);
        });
    });

    describe('a manager appointed to every branch', () => {
        const access = (userId: string, mode: unknown, as_ = adminId) => request(app).put(`/users/${userId}/branch-access`).set(as(as_)).send({ mode });

        it('sees every branch (never the warehouse), also a branch created later; and can go back to a list of branches', async () => {
            const mgr = await make('abm', UserRole.MANAGER);
            const sku = await newSku((await newStyle()).id);
            await open(sku.id, hamraId, 5);
            await open(sku.id, tripoliId, 5);
            await sell(staffId, hamraId, sku.id, 1);
            await sell(staff2Id, tripoliId, sku.id, 1);
            const ids = async () => (await request(app).get('/branches').set(as(mgr))).body.map((b: { id: string }) => b.id);
            expect(await ids()).toEqual([]);                                                          // no branch granted yet

            const all = await access(mgr, 'all');
            expect(all.status, JSON.stringify(all.body)).toBe(200);
            expect(all.body.mode).toBe('all');
            const seen = await ids();
            expect(seen).toEqual(expect.arrayContaining([hamraId, tripoliId]));
            expect(seen).not.toContain(warehouseId);
            expect((await request(app).get(`/stock?branchId=${warehouseId}`).set(as(mgr))).status).toBe(403);
            expect((await request(app).get(`/stock?branchId=${tripoliId}`).set(as(mgr))).status).toBe(200);
            const history = await request(app).get('/sales/history?limit=200').set(as(mgr));
            expect(new Set(history.body.sales.map((s: { branch: { id: string } }) => s.branch.id))).toEqual(expect.objectContaining(new Set([hamraId, tripoliId])));
            const me = await request(app).get('/auth/me').set(as(mgr));
            expect(me.body.branchIds).toEqual(expect.arrayContaining([hamraId, tripoliId]));

            const later = (await request(app).post('/branches').set(as(adminId)).send({ code: `ABL-${stamp}`, name: 'Opened later' })).body.id;
            expect(await ids()).toContain(later);                                                     // nothing to do for the manager: the new branch is theirs too

            expect((await access(mgr, 'selected')).body.mode).toBe('selected');
            expect(await ids()).toEqual([]);                                                          // back to the list (which is empty)
            await request(app).put(`/users/${mgr}/branches/${hamraId}`).set(as(adminId));
            expect(await ids()).toEqual([hamraId]);
            const read = await request(app).get(`/users/${mgr}/branch-access`).set(as(adminId));
            expect(read.body).toEqual({ userId: mgr, mode: 'selected', branchIds: [hamraId] });
        });

        it('the manager with every branch can also manage the employees of any branch', async () => {
            const mgr = await make('abm2', UserRole.MANAGER);
            await access(mgr, 'all');
            expect((await request(app).put(`/users/${staff2Id}/permissions`).set(as(mgr)).send({ permissions: { 'reports.financial': true } })).status).toBe(200);        // an employee of Tripoli
            await request(app).put(`/users/${staff2Id}/permissions`).set(as(mgr)).send({ permissions: { 'reports.financial': false } });
        });

        it('only the admin decides, only for a manager, and bad input is refused', async () => {
            const mgr = await make('abm3', UserRole.MANAGER);
            const emp = await make('abe', UserRole.EMPLOYEE);
            expect((await access(mgr, 'all', managerId)).status).toBe(403);
            expect((await access(mgr, 'all', staffId)).status).toBe(403);
            expect((await request(app).put(`/users/${mgr}/branch-access`).send({ mode: 'all' })).status).toBe(401);
            expect((await access(emp, 'all')).status).toBe(409);                                       // an employee is never appointed to every branch
            expect((await access(adminId, 'all')).status).toBe(409);                                   // an admin already reaches everything
            for (const mode of ['every', '', 5, null, undefined]) expect((await access(mgr, mode)).status, String(mode)).toBe(400);
            expect((await access(randomUUID(), 'all')).status).toBe(404);
            expect((await request(app).get(`/users/${mgr}/branch-access`).set(as(managerId))).status).toBe(403);
            const audit = await request(app).get(`/audit-events?entityType=user&entityId=${mgr}`).set(as(adminId));
            expect(audit.body.filter((e: { action: string }) => e.action === 'user.branch_access')).toHaveLength(0);       // nothing changed, nothing recorded
            await access(mgr, 'all');
            const after = await request(app).get(`/audit-events?entityType=user&entityId=${mgr}`).set(as(adminId));
            expect(after.body.find((e: { action: string }) => e.action === 'user.branch_access')).toMatchObject({ by: { id: adminId }, details: { before: 'selected', after: 'all' } });
        });
    });


    describe('the places a transfer can go to', () => {
        it('anyone who may send or receive transfers sees every active place (name and kind only), the warehouse first; an employee who is allowed to send can fill the whole form', async () => {
            const employeeId = await make('plc', UserRole.EMPLOYEE);
            await request(app).put(`/users/${employeeId}/branches/${hamraId}`).set(as(adminId));
            expect((await request(app).get('/branches').set(as(employeeId))).body.map((b: { id: string }) => b.id)).toEqual([hamraId]);       // GET /branches shows only their own
            expect((await request(app).get('/places').set(as(employeeId))).status).toBe(403);                                                   // a plain employee has neither right
            await request(app).put(`/users/${employeeId}/permissions`).set(as(adminId)).send({ permissions: { 'transfers.receive': true } });

            const res = await request(app).get('/places').set(as(employeeId));
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body[0].kind).toBe('warehouse');
            expect(res.body.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining([warehouseId, hamraId, tripoliId]));
            expect(Object.keys(res.body[0]).sort()).toEqual(['code', 'id', 'kind', 'name']);

            // with the permission to send, they prepare a transfer FROM their branch TO a place they could not see before
            await request(app).put(`/users/${employeeId}/permissions`).set(as(adminId)).send({ permissions: { 'transfers.dispatch': true } });
            const sku = await newSku((await newStyle()).id);
            await open(sku.id, hamraId, 5);
            const sent = await request(app).post('/transfers').set(as(employeeId)).set('Idempotency-Key', key()).send({ sourceBranchId: hamraId, destinationBranchId: tripoliId, lines: [{ skuId: sku.id, quantity: 2 }] });
            expect(sent.status, JSON.stringify(sent.body)).toBe(201);

            const inactive = (await request(app).post('/branches').set(as(adminId)).send({ code: `PLI-${stamp}`, name: 'Closed place' })).body.id;
            await request(app).patch(`/branches/${inactive}`).set(as(adminId)).send({ isActive: false });
            expect((await request(app).get('/places').set(as(adminId))).body.map((p: { id: string }) => p.id)).not.toContain(inactive);
            expect((await request(app).get('/places')).status).toBe(401);
        });

        it('someone with neither permission gets 403', async () => {
            const nobody = await make('plcno', UserRole.EMPLOYEE);
            expect((await request(app).get('/places').set(as(nobody))).status).toBe(403);                      // an employee has neither right by default
            await request(app).put(`/users/${nobody}/permissions`).set(as(adminId)).send({ permissions: { 'transfers.receive': true } });
            expect((await request(app).get('/places').set(as(nobody))).status).toBe(200);
            await request(app).put(`/users/${nobody}/permissions`).set(as(adminId)).send({ permissions: { 'transfers.receive': false } });
            expect((await request(app).get('/places').set(as(nobody))).status).toBe(403);
        });
    });

    describe('where the warehouse is', () => {
        it('anyone logged in learns which place is the warehouse (to ask it to restock), nothing about its stock', async () => {
            const res = await request(app).get('/warehouse').set(as(staffId));
            expect(res.status).toBe(200);
            expect(Object.keys(res.body).sort()).toEqual(['code', 'id', 'name']);
            expect(res.body.id).toBe(warehouseId);
            expect((await request(app).get('/warehouse')).status).toBe(401);
            expect((await request(app).get(`/stock?branchId=${warehouseId}`).set(as(staffId))).status).toBe(403);        // but not its stock
        });
    });
});
