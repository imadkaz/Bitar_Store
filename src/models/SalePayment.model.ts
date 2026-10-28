import { ValidationError } from "../utils/exeptions/ValidationError";
import { MAX_CENTS, PaymentMethod } from "./SaleLine.model";

export interface PaymentInput {
    method: PaymentMethod;
    amountCents: number;          // the part of the sale paid with this method (change is NOT part of it)
    tenderedCents?: number;       // cash only: what the customer handed over (default: exactly the amount)
    whishReference?: string;      // Whish only: the transfer reference the business verified
}

export class SalePayment {
    private constructor(
        readonly method: PaymentMethod,
        readonly amountCents: number,
        readonly tenderedCents: number | null,
        readonly whishReference: string | null,
        readonly receivedBy: string,
    ) {}

    static create(input: PaymentInput, receivedBy: string): SalePayment {
        if (!Number.isInteger(input.amountCents) || input.amountCents < 1 || BigInt(input.amountCents) > MAX_CENTS) {
            throw new ValidationError('A payment amount must be above zero');
        }
        if (input.method === 'cash') {
            if (input.whishReference !== undefined) throw new ValidationError('A cash payment has no Whish reference');
            const tendered = input.tenderedCents ?? input.amountCents;
            if (!Number.isInteger(tendered) || tendered < input.amountCents) throw new ValidationError('The cash given cannot be less than the cash amount');
            return new SalePayment('cash', input.amountCents, tendered, null, receivedBy);
        }
        if (input.method === 'whish') {
            if (input.tenderedCents !== undefined) throw new ValidationError('A Whish payment has no cash given');
            const reference = typeof input.whishReference === 'string' ? input.whishReference.trim() : '';
            if (reference.length === 0) throw new ValidationError('A Whish payment needs the transfer reference');
            if (reference.length > 64 || !/^[\x21-\x7E]+$/.test(reference)) {
                throw new ValidationError('The Whish reference must be 1 to 64 visible characters without spaces');
            }
            return new SalePayment('whish', input.amountCents, null, reference, receivedBy);
        }
        throw new ValidationError('Payment method must be cash or whish');
    }

    getChangeCents(): number {
        return this.tenderedCents === null ? 0 : this.tenderedCents - this.amountCents;
    }
}