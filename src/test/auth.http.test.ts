import 'dotenv/config';
import { vi } from 'vitest';

vi.hoisted(() => {
    process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
    process.env.AUTH_MODE = 'jwt';
});

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../db';
import { createAuthenticate } from '../middlewares/Authenticate';
import { UserRole } from '../models/User.model';
import { UserAccessRepository } from '../repositories/UserAccessRepository';
import { UserRepository } from '../repositories/UserRepository';
import { JwtTokenService } from '../services/JwtTokenService';
import { GetAuthContextUsecase } from '../usecases/auth/GetAuthContextUsecase';
import { createUserWithPassword } from '../test-helpers/createUserWithPassword';
import { waitForDatabase } from '../test-helpers/waitForDatabase';

const stamp = Date.now();
const adminEmail = `login-admin-${stamp}@bitar.test`;
const staffEmail = `login-staff-${stamp}@bitar.test`;
const repo = new UserRepository(prisma);
let adminId = '';
let staffId = '';

const login = (email: string, password: string) => request(app).post('/auth/login').send({ email, password });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
    await waitForDatabase(prisma);   // Neon may still be waking up
    adminId = (await createUserWithPassword(repo, { email: adminEmail, password: 'Password#123', fullName: 'Login Admin', role: UserRole.ADMIN }, null)).getId();
    staffId = (await createUserWithPassword(repo, { email: staffEmail, password: 'Password#123', fullName: 'Login Staff', role: UserRole.EMPLOYEE }, adminId)).getId();
}, 60_000);

afterAll(async () => {
    const ids = [adminId, staffId].filter(Boolean);   // if beforeAll failed there is nothing to clean up (an empty id is not a valid uuid)
    if (ids.length === 0) return;
    await prisma.userBranchAccess.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

describe('POST /auth/login and GET /auth/me (real database)', () => {
    it('logs in: token + user, and nothing secret in the response', async () => {
        const res = await login(adminEmail.toUpperCase(), 'Password#123');
        expect(res.status).toBe(200);
        expect(typeof res.body.token).toBe('string');
        expect(res.body.user).toMatchObject({ id: adminId, role: 'admin', isActive: true });
        expect(res.body.user.hasPassword).toBe(true);
        expect(JSON.stringify(res.body.user)).not.toMatch(/passwordHash|password_hash|\$2[aby]\$/i);   // only the true/false flag, never the hash
    });

    it('/auth/me tells the frontend who it is and what it may do', async () => {
        const token = (await login(adminEmail, 'Password#123')).body.token;
        const me = await request(app).get('/auth/me').set(bearer(token));
        expect(me.status).toBe(200);
        expect(me.body.user.id).toBe(adminId);
        expect(me.body.permissions).toContain('users.administer');
        expect(me.body.canViewCosts).toBe(true);

        const staffToken = (await login(staffEmail, 'Password#123')).body.token;
        const staffMe = await request(app).get('/auth/me').set(bearer(staffToken));
        expect(staffMe.body.permissions).not.toContain('users.administer');
        expect(staffMe.body.canViewCosts).toBe(false);
    });

    it('wrong password and unknown email look identical (401); missing fields are 400', async () => {
        const wrong = await login(adminEmail, 'wrong-password');
        const unknown = await login(`ghost-${stamp}@bitar.test`, 'wrong-password');
        expect(wrong.status).toBe(401);
        expect(unknown.status).toBe(401);
        expect(wrong.body.message).toBe(unknown.body.message);
        expect((await request(app).post('/auth/login').send({})).status).toBe(400);
        expect((await request(app).post('/auth/login')).status).toBe(400);
    });

    it('protected routes need a valid token; the dev header is ignored in jwt mode', async () => {
        expect((await request(app).get('/auth/me')).status).toBe(401);
        expect((await request(app).get('/auth/me').set(bearer('garbage'))).status).toBe(401);
        expect((await request(app).get('/auth/me').set({ 'X-User-Id': adminId })).status).toBe(401);
        expect((await request(app).get('/auth/me').set({ Authorization: 'Basic abc' })).status).toBe(401);
    });

    it('a token for a user that does not exist is refused', async () => {
        const ghostToken = new JwtTokenService(process.env.JWT_SECRET!).sign('00000000-0000-4000-8000-000000000000');
        expect((await request(app).get('/auth/me').set(bearer(ghostToken))).status).toBe(401);
    });

    it('the token works on other routes: staff are forbidden, the admin is allowed', async () => {
        const staffToken = (await login(staffEmail, 'Password#123')).body.token;
        const adminToken = (await login(adminEmail, 'Password#123')).body.token;
        expect((await request(app).get('/users').set(bearer(staffToken))).status).toBe(403);
        expect((await request(app).get('/users').set(bearer(adminToken))).status).toBe(200);
    });

    it('a user created WITHOUT a password cannot log in until the admin sets one', async () => {
        const adminToken = (await login(adminEmail, 'Password#123')).body.token;
        const email = `login-nopass-${stamp}@bitar.test`;
        const created = await request(app).post('/users').set(bearer(adminToken)).send({ email, fullName: 'No Password Yet', role: 'employee' });
        expect(created.status).toBe(201);
        expect(created.body.hasPassword).toBe(false);

        const refused = await login(email, 'anything-at-all');
        expect(refused.status).toBe(401);
        expect(refused.body.message).toBe('Invalid email or password');   // same message: it does not reveal that the account exists

        expect((await request(app).put(`/users/${created.body.id}/password`).set(bearer(adminToken)).send({ password: 'FirstPassword#1' })).status).toBe(204);
        expect((await login(email, 'FirstPassword#1')).status).toBe(200);
        await prisma.user.deleteMany({ where: { id: created.body.id } });
    });

    it('changing the password: the old one stops working, the new one works', async () => {
        const adminToken = (await login(adminEmail, 'Password#123')).body.token;
        const reset = await request(app).put(`/users/${staffId}/password`).set(bearer(adminToken)).send({ password: 'NewPassword#456' });
        expect(reset.status).toBe(204);
        expect((await login(staffEmail, 'Password#123')).status).toBe(401);
        expect((await login(staffEmail, 'NewPassword#456')).status).toBe(200);
    });

    it('deactivating a user kills their token at once, and blocks a new login', async () => {
        const adminToken = (await login(adminEmail, 'Password#123')).body.token;
        const staffToken = (await login(staffEmail, 'NewPassword#456')).body.token;
        expect((await request(app).get('/auth/me').set(bearer(staffToken))).status).toBe(200);

        await request(app).patch(`/users/${staffId}`).set(bearer(adminToken)).send({ isActive: false });
        expect((await request(app).get('/auth/me').set(bearer(staffToken))).status).toBe(401);
        expect((await login(staffEmail, 'NewPassword#456')).status).toBe(401);
    });

    it('the dev header cannot be switched on in production', () => {
        const old = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        const build = () =>
            createAuthenticate(new GetAuthContextUsecase(repo, new UserAccessRepository(prisma)), new JwtTokenService(process.env.JWT_SECRET!), { allowDevHeader: true });
        expect(build).toThrow('must never be enabled in production');
        process.env.NODE_ENV = old;
    });
});
