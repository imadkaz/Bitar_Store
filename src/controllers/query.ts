import { Request } from 'express';
import { ValidationError } from '../utils/exeptions/ValidationError';

// Query-string readers: a bad value is a 400 with a message, never a crash.
export function intParam(req: Request, name: string): number | undefined {
    const raw = req.query[name];
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string' || !/^-?\d+$/.test(raw.trim())) throw new ValidationError(`${name} must be a whole number`);
    return Number(raw);
}

export function textParam(req: Request, name: string): string | undefined {
    const raw = req.query[name];
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') throw new ValidationError(`${name} must be text`);
    return raw;
}

export function boolParam(req: Request, name: string): boolean | undefined {
    const raw = req.query[name];
    if (raw === undefined) return undefined;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new ValidationError(`${name} must be true or false`);
}
