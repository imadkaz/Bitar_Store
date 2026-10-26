// src/middleware/errorHandler.ts  (إذا عندك واحد، ضيف بس سطري 401 و403)
import { NextFunction, Request, Response } from 'express';
import { ConflictError } from '../utils/exeptions/ConflictError';
import { ForbiddenError } from '../utils/exeptions/ForbiddenError';
import { NotFoundError } from '../utils/exeptions/NotFoundError';
import { UnauthorizedError } from '../utils/exeptions/UnauthorizedError';
import { ValidationError } from '../utils/exeptions/ValidationError';

// The ONLY place that knows which domain error means which HTTP status. Must keep its 4 parameters.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
    if (err instanceof ValidationError) return res.status(400).json({ message: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ message: err.message });
    if (err instanceof ForbiddenError) return res.status(403).json({ message: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ message: err.message });
    if (err instanceof ConflictError) return res.status(409).json({ message: err.message });

    const type = (err as { type?: string } | null)?.type;
    if (type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid JSON body' });
    if (type === 'entity.too.large') return res.status(413).json({ message: 'Request body too large' });

    console.error('Unhandled error:', err);
    return res.status(500).json({ message: 'Internal Server Error' });
}