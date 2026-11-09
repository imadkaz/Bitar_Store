import { ValidationError } from '../utils/exeptions/ValidationError';

export interface CreateSupplierRequest { name: string; phone: string; note: string | null }
export interface UpdateSupplierRequest { name?: string; phone?: string; note?: string | null; isActive?: boolean }

const CONTROL = /[\u0000-\u001f\u007f]/;

function asObject(body: unknown): Record<string, unknown> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ValidationError('The request body is required');
    return body as Record<string, unknown>;
}

export function normalizeSupplierName(value: unknown): string {
    if (typeof value !== 'string') throw new ValidationError('name is required');
    const name = value.trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 100 || CONTROL.test(name)) throw new ValidationError('name must be 2 to 100 characters');
    return name;
}

// digits, spaces and + - ( ), 5 to 30 characters
function normalizePhone(value: unknown): string {
    if (typeof value !== 'string') throw new ValidationError('phone is required');
    const phone = value.trim().replace(/\s+/g, ' ');
    if (phone.length < 5 || phone.length > 30 || !/^[0-9+\-() ]+$/.test(phone)) throw new ValidationError('phone must be 5 to 30 characters: digits, spaces and + - ( )');
    return phone;
}

function normalizeNote(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.trim().length > 200 || CONTROL.test(value)) throw new ValidationError('note must be at most 200 characters');
    return value.trim() === '' ? null : value.trim();
}

// BL-06: a supplier has at least a name and a phone number
export function parseCreateSupplier(body: unknown): CreateSupplierRequest {
    const input = asObject(body);
    return { name: normalizeSupplierName(input.name), phone: normalizePhone(input.phone), note: normalizeNote(input.note) };
}

export function parseUpdateSupplier(body: unknown): UpdateSupplierRequest {
    const input = asObject(body);
    const unknown = Object.keys(input).filter((k) => !['name', 'phone', 'note', 'isActive'].includes(k));
    if (unknown.length > 0) throw new ValidationError('You can change only: name, phone, note, isActive');
    const out: UpdateSupplierRequest = {};
    if (input.name !== undefined) out.name = normalizeSupplierName(input.name);
    if (input.phone !== undefined) out.phone = normalizePhone(input.phone);
    if (input.note !== undefined) out.note = normalizeNote(input.note);
    if (input.isActive !== undefined) {
        if (typeof input.isActive !== 'boolean') throw new ValidationError('isActive must be true or false');
        out.isActive = input.isActive;
    }
    if (Object.keys(out).length === 0) throw new ValidationError('Nothing to change');
    return out;
}
