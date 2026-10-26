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
const mail = (tag: string) => `${tag}-${stamp}@bitar.test`;
const repo = new UserRepository(prisma);
let adminId = '';
let employeeId = '';
let inactiveId = '';

// real tokens, signed like the login does
const tokens = new JwtTokenService(process.env.JWT_SECRET!);
const as = (id: string) => ({ Authorization: `Bearer ${tokens.sign(id)}` });

beforeAll(async () => {
    await waitForDatabase(prisma);   // Neon may still be waking up
    adminId = (await createUserWithPassword(repo, { email: mail('admin'), password: 'Password#123', fullName: 'Admin', role: UserRole.ADMIN }, null)).getId();
    employeeId = (await createUserWithPassword(repo, { email: mail('emp'), password: 'Password#123', fullName: 'Employee', role: UserRole.EMPLOYEE }, adminId)).getId();
    inactiveId = (await createUserWithPassword(repo, { email: mail('off'), password: 'Password#123', fullName: 'Inactive', role: UserRole.EMPLOYEE }, adminId)).getId();
    await prisma.user.update({ where: { id: inactiveId }, data: { isActive: false, deactivatedAt: new Date() } });
}, 60_000);

afterAll(async () => {
    const ids = (await prisma.user.findMany({ where: { email: { endsWith: `-${stamp}@bitar.test` } } })).map((u) => u.id);
    await prisma.userBranchAccess.deleteMany({ where: { userId: { in: ids } } });
    await prisma.branch.deleteMany({ where: { code: { endsWith: `-${stamp}` } } });   // branches point at users (created_by): delete them first
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

describe('/users (real database, real tokens)', () => {
    it('refuses callers it cannot identify', async () => {
        expect((await request(app).get('/users')).status).toBe(401);
        expect((await request(app).get('/users').set({ Authorization: 'Bearer garbage' })).status).toBe(401);
        expect((await request(app).get('/users').set(as(randomUUID()))).status).toBe(401);
        expect((await request(app).get('/users').set(as(inactiveId))).status).toBe(401);
    });

    it('employees are forbidden, admins are allowed', async () => {
        expect((await request(app).get('/users').set(as(employeeId))).status).toBe(403);
        expect((await request(app).get('/users').set(as(adminId))).status).toBe(200);
    });

    it('POST creates a user WITHOUT a password: 201, created_by saved, hasPassword false, nothing secret in the response', async () => {
        const res = await request(app).post('/users').set(as(adminId))
            .send({ email: mail('New'), fullName: 'New Person', role: 'manager', isAdmin: true, id: 'chosen-by-client' });
        expect(res.status).toBe(201);
        expect(res.body.email).toBe(mail('new'));
        expect(res.body.hasPassword).toBe(false);
        expect(res.body.id).not.toBe('chosen-by-client');
        expect(JSON.stringify(res.body)).not.toMatch(/hash|\$2/i);

        const row = await prisma.user.findUnique({ where: { id: res.body.id } });
        expect(row?.createdBy).toBe(adminId);
        expect(row?.role).toBe('manager');
        expect(row?.passwordHash).toBeNull();
    });

    it('POST refuses a password in the body (400) and creates nothing', async () => {
        const res = await request(app).post('/users').set(as(adminId))
            .send({ email: mail('withpw'), password: 'Password#123', fullName: 'With Password', role: 'employee' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/PUT \/users\/:id\/password/);
        expect(await prisma.user.findFirst({ where: { email: mail('withpw') } })).toBeNull();
    });

    it('POST errors are 400/409, never 500', async () => {
        const body = { email: mail('dup'), fullName: 'Dup', role: 'employee' };
        expect((await request(app).post('/users').set(as(adminId)).send(body)).status).toBe(201);
        expect((await request(app).post('/users').set(as(adminId)).send(body)).status).toBe(409);
        expect((await request(app).post('/users').set(as(adminId)).send({ ...body, email: mail('x2'), role: 'boss' })).status).toBe(400);
        expect((await request(app).post('/users').set(as(adminId)).send({})).status).toBe(400);
        expect((await request(app).post('/users').set(as(adminId))).status).toBe(400);   // no body at all
        expect((await request(app).post('/users').set(as(adminId)).set('Content-Type', 'application/json').send('{"email":')).status).toBe(400);
    });

    it('GET lists users with hasPassword and without any secret', async () => {
        const res = await request(app).get('/users').set(as(adminId));
        expect(res.body.length).toBeGreaterThanOrEqual(3);
        expect(res.body.every((u: { hasPassword: unknown }) => typeof u.hasPassword === 'boolean')).toBe(true);
        expect(JSON.stringify(res.body)).not.toMatch(/hash|\$2/i);
    });

    it('PUT /users/:id/password sets the first password, then replaces it', async () => {
        const created = await request(app).post('/users').set(as(adminId)).send({ email: mail('pw1'), fullName: 'Password Person', role: 'employee' });
        const id = created.body.id;

        expect((await request(app).put(`/users/${id}/password`).set(as(adminId)).send({ password: 'FirstPassword#1' })).status).toBe(204);
        const first = await prisma.user.findUnique({ where: { id } });
        expect(first?.passwordHash).toMatch(/^\$2[aby]\$/);
        expect(first?.passwordHash).not.toBe('FirstPassword#1');
        const listed = (await request(app).get('/users').set(as(adminId))).body.find((u: { id: string }) => u.id === id);
        expect(listed.hasPassword).toBe(true);

        expect((await request(app).put(`/users/${id}/password`).set(as(adminId)).send({ password: 'SecondPassword#2' })).status).toBe(204);
        expect((await prisma.user.findUnique({ where: { id } }))?.passwordHash).not.toBe(first?.passwordHash);
    });

    it('PUT /users/:id/password errors: bad password 400, unknown id 404, non-uuid id 404, employee 403', async () => {
        const nobody = '00000000-0000-4000-8000-000000000000';
        expect((await request(app).put(`/users/${employeeId}/password`).set(as(adminId)).send({ password: 'short' })).status).toBe(400);
        expect((await request(app).put(`/users/${employeeId}/password`).set(as(adminId)).send({})).status).toBe(400);
        expect((await request(app).put(`/users/${employeeId}/password`).set(as(adminId))).status).toBe(400);
        expect((await request(app).put(`/users/${nobody}/password`).set(as(adminId)).send({ password: 'Password#123' })).status).toBe(404);
        expect((await request(app).put('/users/abc/password').set(as(adminId)).send({ password: 'Password#123' })).status).toBe(404);
        expect((await request(app).put(`/users/${employeeId}/password`).set(as(employeeId)).send({ password: 'Password#123' })).status).toBe(403);
    });

    it('PATCH saves email, name and role, never the password', async () => {
        const created = await request(app).post('/users').set(as(adminId)).send({ email: mail('p1'), fullName: 'Patch Me', role: 'employee' });
        const res = await request(app).patch(`/users/${created.body.id}`).set(as(adminId))
            .send({ email: mail('p1-new'), fullName: 'Patched', role: 'manager' });
        expect(res.status).toBe(200);

        const after = await prisma.user.findUnique({ where: { id: created.body.id } });
        expect(after?.email).toBe(mail('p1-new'));
        expect(after?.fullName).toBe('Patched');
        expect(after?.role).toBe('manager');
        expect(after?.updatedBy).toBe(adminId);
        expect(after?.passwordHash).toBeNull();

        const withPassword = await request(app).patch(`/users/${created.body.id}`).set(as(adminId)).send({ password: 'Password#123' });
        expect(withPassword.status).toBe(400);
    });

    it('PATCH: deactivation works and kills that user\'s access immediately', async () => {
        const target = await createUserWithPassword(repo, { email: mail('p2'), password: 'Password#123', fullName: 'To Deactivate', role: UserRole.EMPLOYEE }, adminId);
        expect((await request(app).get('/users').set(as(target.getId()))).status).toBe(403);   // identified, just not admin
        const off = await request(app).patch(`/users/${target.getId()}`).set(as(adminId)).send({ isActive: false });
        expect(off.status).toBe(200);
        expect(off.body.isActive).toBe(false);
        expect((await request(app).get('/users').set(as(target.getId()))).status).toBe(401);
    });

    it('PATCH errors: self-deactivation 409, unknown id 404, non-uuid id 404, taken email 409', async () => {
        expect((await request(app).patch(`/users/${adminId}`).set(as(adminId)).send({ isActive: false })).status).toBe(409);
        expect((await request(app).patch(`/users/${randomUUID()}`).set(as(adminId)).send({ fullName: 'Nobody' })).status).toBe(404);
        expect((await request(app).patch('/users/abc').set(as(adminId)).send({ fullName: 'Nobody' })).status).toBe(404);
        expect((await request(app).patch(`/users/${employeeId}`).set(as(adminId)).send({ email: mail('admin') })).status).toBe(409);
        expect((await request(app).patch(`/users/${employeeId}`).set(as(adminId))).status).toBe(200);   // empty update is a no-op
    });

    it('branch access end to end: before grant [], after grant the branch, after revoke []', async () => {
        const branch = await request(app).post('/branches').set(as(adminId)).send({ code: `acc-${stamp}`, name: 'Access Branch' });
        const other = await request(app).post('/branches').set(as(adminId)).send({ code: `oth-${stamp}`, name: 'Other Branch' });
        const emp = await request(app).post('/users').set(as(adminId)).send({ email: mail('acc'), fullName: 'Access Test', role: 'employee' });
        const seen = async () => (await request(app).get('/branches').set(as(emp.body.id))).body.map((b: { id: string }) => b.id);

        expect(await seen()).toEqual([]);
        expect((await request(app).put(`/users/${emp.body.id}/branches/${branch.body.id}`).set(as(adminId))).status).toBe(204);
        expect((await request(app).put(`/users/${emp.body.id}/branches/${branch.body.id}`).set(as(adminId))).status).toBe(204);   // repeat is fine
        expect(await seen()).toEqual([branch.body.id]);
        expect(await seen()).not.toContain(other.body.id);
        expect((await request(app).delete(`/users/${emp.body.id}/branches/${branch.body.id}`).set(as(adminId))).status).toBe(204);
        expect(await seen()).toEqual([]);
    });

    it('branch access errors: employee 403, unknown user 404, non-uuid ids 404, inactive branch 409', async () => {
        const branch = await request(app).post('/branches').set(as(adminId)).send({ code: `err-${stamp}`, name: 'Err Branch' });
        const nobody = '00000000-0000-4000-8000-000000000000';
        expect((await request(app).put(`/users/${employeeId}/branches/${branch.body.id}`).set(as(employeeId))).status).toBe(403);
        expect((await request(app).put(`/users/${nobody}/branches/${branch.body.id}`).set(as(adminId))).status).toBe(404);
        expect((await request(app).put(`/users/abc/branches/${branch.body.id}`).set(as(adminId))).status).toBe(404);
        expect((await request(app).put(`/users/${employeeId}/branches/abc`).set(as(adminId))).status).toBe(404);
        expect((await request(app).put(`/users/${employeeId}/branches/${nobody}`).set(as(adminId))).status).toBe(404);
        await prisma.branch.update({ where: { id: branch.body.id }, data: { isActive: false } });
        expect((await request(app).put(`/users/${employeeId}/branches/${branch.body.id}`).set(as(adminId))).status).toBe(409);
    });

    it('CORS allows the Authorization header and the PUT method', async () => {
        const preflight = await request(app).options('/users').set('Origin', 'http://localhost:3001')
            .set('Access-Control-Request-Method', 'PUT').set('Access-Control-Request-Headers', 'authorization,content-type');
        expect(preflight.headers['access-control-allow-headers']).toMatch(/authorization/i);
        expect(preflight.headers['access-control-allow-methods']).toMatch(/PUT/);
    });
});
