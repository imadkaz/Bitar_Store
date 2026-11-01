import { createHash } from 'node:crypto';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { isUuid } from '../../utils/uuid';

// What the client sends, checked and made exact. Pure: no database here. (The domain checks the rules of a transfer.)
function asObject(value: unknown, what = 'The request body'): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError(`${what} is required`);
    return value as Record<string, unknown>;
}

function uuidOf(value: unknown, label: string): string {
    if (typeof value !== 'string' || !isUuid(value)) throw new ValidationError(`${label} must be a valid id`);
    return value;
}

function listOf(value: unknown, label: string, max: number): unknown[] {
    if (!Array.isArray(value)) throw new ValidationError(`${label} must be a list`);
    if (value.length > max) throw new ValidationError(`${label} is too long`);
    return value;
}

export interface CreateTransferRequest {
    sourceBranchId: string;
    destinationBranchId: string;
    note: string | null;
    lines: { skuId: string; quantity: number }[];
}

export function parseCreateTransfer(body: unknown): CreateTransferRequest {
    const input = asObject(body);
    const lines = listOf(input.lines, 'lines', 200).map((raw, i) => {
        const line = asObject(raw, `Line ${i + 1}`);
        return { skuId: uuidOf(line.skuId, `Line ${i + 1}: skuId`), quantity: line.quantity as number };
    });
    return {
        sourceBranchId: uuidOf(input.sourceBranchId, 'sourceBranchId'),
        destinationBranchId: uuidOf(input.destinationBranchId, 'destinationBranchId'),
        note: (input.note ?? null) as string | null,
        lines,
    };
}

// optional: send less than asked on some lines
export function parseDispatchBody(body: unknown): { skuId: string; quantity: number }[] | undefined {
    if (body === undefined || body === null) return undefined;
    const input = asObject(body);
    if (input.lines === undefined) return undefined;
    return listOf(input.lines, 'lines', 200).map((raw, i) => {
        const line = asObject(raw, `Line ${i + 1}`);
        return { skuId: uuidOf(line.skuId, `Line ${i + 1}: skuId`), quantity: line.quantity as number };
    });
}

export function parseReceiveBody(body: unknown): { skuId: string; accepted: number; damaged?: number }[] {
    const input = asObject(body);
    return listOf(input.lines, 'lines', 200).map((raw, i) => {
        const line = asObject(raw, `Line ${i + 1}`);
        return { skuId: uuidOf(line.skuId, `Line ${i + 1}: skuId`), accepted: line.accepted as number, ...(line.damaged === undefined ? {} : { damaged: line.damaged as number }) };
    });
}

export function parseResolveBody(body: unknown): { reason: unknown; lines?: { skuId: string; quantity: number }[] } {
    const input = asObject(body);
    return { reason: input.reason, lines: parseDispatchBody({ lines: input.lines }) };
}

export function hashOf(operation: string, transferId: string | null, payload: unknown): string {
    return createHash('sha256').update(JSON.stringify([operation, transferId, payload])).digest('hex');
}
