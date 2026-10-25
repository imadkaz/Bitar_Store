// src/middleware/authenticate.ts
import { NextFunction, Request, RequestHandler, Response } from 'express';
import { AuthContext } from '../models/AuthContext';
import { UserRole } from '../models/User.model';
import { IUserRepository } from '../repositories/interfaces/IUserRepository';
import { ForbiddenError } from '../utils/exeptions/ForbiddenError';
import { UnauthorizedError } from '../utils/exeptions/UnauthorizedError';
import { isUuid } from '../utils/uuid';
import { Permission } from '../models/Permission';

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            auth?: AuthContext;
        }
    }
}

// DEVELOPMENT ONLY, until the login flow exists: trusts the X-User-Id header (anyone can claim to be anyone).
// It refuses to be created in production, so it can't be shipped by accident.
export function createDevAuthenticate(userRepository: IUserRepository): RequestHandler {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('Dev authentication (X-User-Id) must never run in production');
    }
    return async (req: Request, _res: Response, next: NextFunction) => {
        try {
            const userId = req.header('x-user-id');
            if (typeof userId !== 'string' || !isUuid(userId)) throw new UnauthorizedError('Send a valid X-User-Id header');
            const user = await userRepository.findById(userId);
            if (!user || !user.isActive()) throw new UnauthorizedError('Unknown or inactive user');
            req.auth = new AuthContext(user, new Set<Permission>(), new Set<string>());   // no permissions, no branch access
            next();
        } catch (error) {
            next(error);
        }
    };
}

// Used inside controllers (after `authenticate`) to ask: who is calling?
export function getAuth(req: Request): AuthContext {
    if (!req.auth) throw new UnauthorizedError('Authentication required');
    return req.auth;
}

export const requireRole =
    (...roles: UserRole[]): RequestHandler =>
    (req, _res, next) => {
        try {
            if (!roles.includes(getAuth(req).user.getRole())) throw new ForbiddenError('Insufficient role');
            next();
        } catch (error) {
            next(error);
        }
    };