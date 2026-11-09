import { ValidationError } from '../utils/exeptions/ValidationError';
import { businessDateOf, isRealDate } from '../utils/businessDate';
import { isUuid } from '../utils/uuid';
import { parseMoneyToCents } from './Money';
import { normalizeCurrency } from './Sku.model';

export const MAX_RECEIPT_LINES = 200;
export const MAX_RECEIPT_QUANTITY = 10_000;
export const MAX_UNIT_COST_CENTS = 10_000_000;     // 100,000.00 per piece: keeps the total of 200 lines inside numeric(14,2)

export interface GoodsReceiptLineRequest { skuId: string; quantity: number; unitCostCents: number }

export interface GoodsReceiptRequest {
    supplierId: string | null;               // the supplier chosen from the list ...
    supplierName: string | null;             // ... or named (an existing supplier is found by its name; a manager's request can add a new one)
    supplierInvoiceNumber: string | null;    // optional: not every delivery comes with one
    invoiceDate: string;           // YYYY-MM-DD, the date ON the supplier's invoice
    currency: string;
    note: string | null;
    lines: GoodsReceiptLineRequest[];
}

function asObject(body: unknown): Record<string, unknown> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ValidationError('The request body is required');
    return body as Record<string, unknown>;
}

const CONTROL = /[\u0000-\u001f\u007f]/;

// What the client sent, checked and made exact. Pure: no database here.
export function parseGoodsReceipt(body: unknown, now: Date): GoodsReceiptRequest {
    const input = asObject(body);

    let supplierId: string | null = null;
    if (input.supplierId !== undefined && input.supplierId !== null) {
        if (typeof input.supplierId !== 'string' || !isUuid(input.supplierId)) throw new ValidationError('supplierId must be the id of a supplier');
        supplierId = input.supplierId;
    }
    let supplierName: string | null = null;
    if (input.supplierName !== undefined && input.supplierName !== null) {
        if (typeof input.supplierName !== 'string') throw new ValidationError('supplierName must be text');
        supplierName = input.supplierName.trim().replace(/\s+/g, ' ');
        if (supplierName.length < 2 || supplierName.length > 100 || CONTROL.test(supplierName)) throw new ValidationError('supplierName must be 2 to 100 characters');
    }
    if (supplierId === null && supplierName === null) throw new ValidationError('supplierId is required (or supplierName): who delivered the goods');

    // the supplier's invoice number is optional (BL-06); when it is given it must be a real one
    let supplierInvoiceNumber: string | null = null;
    const supplierInvoiceValue = input.supplierInvoiceNumber;
    if (supplierInvoiceValue !== undefined && supplierInvoiceValue !== null) {
        if (typeof supplierInvoiceValue !== 'string' && typeof supplierInvoiceValue !== 'number') throw new ValidationError('supplierInvoiceNumber must be text or a number');
        const text = String(supplierInvoiceValue).trim();
        if (text.length > 50 || CONTROL.test(text)) throw new ValidationError('supplierInvoiceNumber must be at most 50 characters');
        supplierInvoiceNumber = text === '' ? null : text;
    }

    const today = businessDateOf(now);
    let invoiceDate = today;
    if (input.invoiceDate !== undefined) {
        if (typeof input.invoiceDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.invoiceDate) || !isRealDate(input.invoiceDate)) throw new ValidationError('invoiceDate must be a real date like 2026-11-03');
        if (input.invoiceDate > today) throw new ValidationError('invoiceDate cannot be in the future');
        invoiceDate = input.invoiceDate;
    }
    if (input.currency !== undefined && typeof input.currency !== 'string') throw new ValidationError('currency must be text like USD');
    const currency = normalizeCurrency(input.currency as string | undefined);

    let note: string | null = null;
    const noteValue = input.note;
    if (noteValue !== undefined && noteValue !== null) {
        if (typeof noteValue !== 'string' || noteValue.trim().length > 200) throw new ValidationError('note must be at most 200 characters');
        note = noteValue.trim() === '' ? null : noteValue.trim();
    }

    if (!Array.isArray(input.lines) || input.lines.length === 0) throw new ValidationError('lines must be a list with at least one product');
    if (input.lines.length > MAX_RECEIPT_LINES) throw new ValidationError(`At most ${MAX_RECEIPT_LINES} products in one receipt`);
    const lines = input.lines.map((raw, index): GoodsReceiptLineRequest => {
        const line = asObject(raw);
        const where = `Line ${index + 1}`;
        if (typeof line.skuId !== 'string' || !isUuid(line.skuId)) throw new ValidationError(`${where}: skuId must be the id of a sku`);
        if (typeof line.quantity !== 'number' || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_RECEIPT_QUANTITY) {
            throw new ValidationError(`${where}: quantity must be a whole number between 1 and ${MAX_RECEIPT_QUANTITY}`);
        }
        const unitCostValue = line.unitCost;
if (typeof unitCostValue !== 'string' && typeof unitCostValue !== 'number') throw new ValidationError(`${where}: unitCost is required (0 is allowed)`);
if (line.unitCost === undefined || line.unitCost === null) throw new ValidationError(`${where}: unitCost is required (0 is allowed)`);
const unitCostCents = parseMoneyToCents(unitCostValue, `${where}: unitCost`);
        if (unitCostCents > MAX_UNIT_COST_CENTS) throw new ValidationError(`${where}: unitCost is too large`);
        return { skuId: line.skuId, quantity: line.quantity, unitCostCents };
    });
    if (new Set(lines.map((l) => l.skuId)).size !== lines.length) throw new ValidationError('Each product can appear only once in a receipt');

    return { supplierId, supplierName, supplierInvoiceNumber, invoiceDate, currency, note, lines };
}

// What the supplier's invoice adds up to, in cents (every line is a whole number of pieces times a whole number of cents)
export function totalCostCents(lines: GoodsReceiptLineRequest[]): number {
    return lines.reduce((sum, line) => sum + line.quantity * line.unitCostCents, 0);
}
