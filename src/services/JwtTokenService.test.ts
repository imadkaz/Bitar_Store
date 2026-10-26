import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { UnauthorizedError } from '../utils/exeptions/UnauthorizedError';
import { JwtTokenService } from './JwtTokenService';

const SECRET = 'test-secret-test-secret-test-secret-123456';
const USER_ID = '6e671bb3-413e-4d81-8794-8011ae19d2fb';

describe('JwtTokenService', () => {
    const service = new JwtTokenService(SECRET, '1h');

    it('signs a token that verifies back to the user id, and carries nothing else', () => {
        const token = service.sign(USER_ID);
        expect(service.verify(token)).toBe(USER_ID);
        const payload = jwt.decode(token) as Record<string, unknown>;
        expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'sub']);   // no role, no email, no permissions
    });

    it('rejects an expired token', () => {
        const expired = new JwtTokenService(SECRET, '-10s').sign(USER_ID);
        expect(() => service.verify(expired)).toThrow(UnauthorizedError);
    });

    it('rejects a token signed with another secret', () => {
        const foreign = new JwtTokenService('another-secret-another-secret-another-1234', '1h').sign(USER_ID);
        expect(() => service.verify(foreign)).toThrow(UnauthorizedError);
    });

    it('rejects a token whose payload was edited', () => {
        const [header, , signature] = service.sign(USER_ID).split('.');
        const forgedPayload = Buffer.from(JSON.stringify({ sub: 'someone-else', exp: 9999999999 })).toString('base64url');
        expect(() => service.verify(`${header}.${forgedPayload}.${signature}`)).toThrow(UnauthorizedError);
    });

    it('rejects an unsigned token (alg none) and garbage', () => {
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ sub: USER_ID, exp: 9999999999 })).toString('base64url');
        expect(() => service.verify(`${header}.${payload}.`)).toThrow(UnauthorizedError);
        expect(() => service.verify('garbage')).toThrow(UnauthorizedError);
        expect(() => service.verify('')).toThrow(UnauthorizedError);
    });
});
