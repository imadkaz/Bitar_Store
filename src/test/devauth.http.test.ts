import 'dotenv/config';
import { vi } from 'vitest';

vi.hoisted(() => {
    process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
    process.env.AUTH_MODE = 'dev';   // this file runs the app in dev mode
});

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../db';
import { UserRole } from '../models/User.model';
import { UserRepository } from '../repositories/UserRepository';
import { createUserWithPassword } from '../test-helpers/createUserWithPassword';
import { waitForDatabase } from '../test-helpers/waitForDatabase';

const stamp = Date.now();
let adminId = '';

beforeAll(async () => {
    await waitForDatabase(prisma);   // Neon may still be waking up
    adminId = (await createUserWithPassword(new UserRepository(prisma),
        { email: `dev-admin-${stamp}@bitar.test`, password: 'Password#123', fullName: 'Dev Admin', role: UserRole.ADMIN }, null)).getId();
}, 60_000);

afterAll(async () => {
    if (adminId) await prisma.user.deleteMany({ where: { id: adminId } });
});

describe('AUTH_MODE=dev', () => {
    it('accepts X-User-Id, and still validates it', async () => {
        expect((await request(app).get('/auth/me').set({ 'X-User-Id': adminId })).status).toBe(200);
        expect((await request(app).get('/auth/me').set({ 'X-User-Id': 'abc' })).status).toBe(401);
        expect((await request(app).get('/auth/me').set({ 'X-User-Id': '00000000-0000-4000-8000-000000000000' })).status).toBe(401);
        expect((await request(app).get('/auth/me')).status).toBe(401);
    });

    it('real tokens keep working in dev mode too', async () => {
        const login = await request(app).post('/auth/login').send({ email: `dev-admin-${stamp}@bitar.test`, password: 'Password#123' });
        expect(login.status).toBe(200);
        expect((await request(app).get('/auth/me').set({ Authorization: `Bearer ${login.body.token}` })).status).toBe(200);
    });
});
