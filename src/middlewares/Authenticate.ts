import { NextFunction, Request, RequestHandler, Response } from 'express';
import { AuthContext } from '../models/AuthContext';
import { Permission } from '../models/Permission';
import { UserRole } from '../models/User.model';
import { ITokenService } from '../services/interfaces/ITokenService';
import { GetAuthContextUsecase } from '../usecases/auth/GetAuthContextUsecase';
import { ForbiddenError } from '../utils/exeptions/ForbiddenError';
import { UnauthorizedError } from '../utils/exeptions/UnauthorizedError';
import { isUuid } from '../utils/uuid';

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            auth?: AuthContext;
        }
    }
}

export interface AuthenticateOptions {
    // DEVELOPMENT ONLY: also trust "X-User-Id: <uuid>" when there is no token. Anyone can claim to be anyone.
    allowDevHeader: boolean;
}

// Answers "who is making this request?" and puts the answer on req.auth for the controllers (getAuth).
export function createAuthenticate(
    getAuthContext: GetAuthContextUsecase,
    tokenService: ITokenService,
    options: AuthenticateOptions,
): RequestHandler {
    if (options.allowDevHeader && process.env.NODE_ENV === 'production') {
        throw new Error('The X-User-Id dev header must never be enabled in production');
    }

    return async (req: Request, _res: Response, next: NextFunction) => {
        try {
            const authorization = req.headers.authorization;
            const devHeader = req.header('x-user-id');
            let userId: string;

            if (authorization?.startsWith('Bearer ')) {
                userId = tokenService.verify(authorization.slice('Bearer '.length).trim());
            } else if (options.allowDevHeader && devHeader) {
                userId = devHeader;
            } else {
                throw new UnauthorizedError('Authentication required');
            }

            if (!isUuid(userId)) throw new UnauthorizedError('Invalid or expired token');
            // loads the user fresh from the database: deactivating a user or changing a role is effective immediately
            req.auth = await getAuthContext.execute(userId);
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

export const requirePermission =
    (permission: Permission): RequestHandler =>
    (req, _res, next) => {
        try {
            if (!getAuth(req).can(permission)) throw new ForbiddenError(`Missing permission: ${permission}`);
            next();
        } catch (error) {
            next(error);
        }
    };
