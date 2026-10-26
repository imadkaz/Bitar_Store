import jwt from 'jsonwebtoken';
import { UnauthorizedError } from '../utils/exeptions/UnauthorizedError';
import { ITokenService } from './interfaces/ITokenService';

export class JwtTokenService implements ITokenService {
    constructor(
        private readonly secret: string,
        private readonly expiresIn: string = '8h',
    ) {}

    // the token carries ONLY the user id; role and permissions are loaded from the database on each request
    sign(userId: string): string {
        return jwt.sign({}, this.secret, {
            subject: userId,
            expiresIn: this.expiresIn as jwt.SignOptions['expiresIn'],
            algorithm: 'HS256',
        });
    }

    verify(token: string): string {
        try {
            const payload = jwt.verify(token, this.secret, { algorithms: ['HS256'] });
            if (typeof payload === 'string' || !payload.sub) throw new Error('missing subject');
            return payload.sub;
        } catch {
            throw new UnauthorizedError('Invalid or expired token');
        }
    }
}
