import { ValidationError } from "../utils/exeptions/ValidationError";
import { ConflictError } from "../utils/exeptions/ConflictError";
import { Fx, usdCentsToLbp } from "./Lbp";
import { MAX_CENTS, PaymentMethod } from "./SaleLine.model";

export type PaymentCurrency = 'USD' | 'LBP';

export interface PaymentInput {
    method: PaymentMethod;
    amountCents: number;          // the part of the sale paid with this method (change is NOT part of it)
    tenderedCents?: number;       // cash only: what the customer handed over (default: exactly the amount)
    whishReference?: string;      // Whish only: the transfer reference the business verified
    currency?: PaymentCurrency;   // cash only: USD (default), or LBP: the amount is the dollar value of the pounds received
    changeLbpCents?: number;      // cash in USD only: the part of the change, in dollars, that is given back in pounds
}

export class SalePayment {
    private constructor(
        readonly method: PaymentMethod,
        readonly amountCents: number,
        readonly tenderedCents: number | null,
        readonly whishReference: string | null,
        readonly receivedBy: string,
        readonly currency: PaymentCurrency = 'USD',
        readonly lbpAmount: number | null = null,               // LBP payment: the pounds received
        readonly exchangeRate: number | null = null,            // the rate used for those pounds (or for the pounds of the change)
        readonly changeLbpCents: number = 0,                    // the part of the change given in pounds, in dollars ...
        readonly changeLbp: number | null = null,               // ... and in pounds
    ) {}

    static create(input: PaymentInput, receivedBy: string, fx: Fx | null = null): SalePayment {
        if (!Number.isInteger(input.amountCents) || input.amountCents < 1 || BigInt(input.amountCents) > MAX_CENTS) {
            throw new ValidationError('A payment amount must be above zero');
        }
        if (input.method === 'cash') {
            if (input.whishReference !== undefined) throw new ValidationError('A cash payment has no Whish reference');
            const currency = input.currency ?? 'USD';
            if (currency !== 'USD' && currency !== 'LBP') throw new ValidationError('currency must be USD or LBP');
            if (currency === 'LBP') {
                // the pounds of this payment: its dollar amount at the rate of the day, rounded to the step; nothing is "tendered" or given back in pounds
                if (input.tenderedCents !== undefined) throw new ValidationError('A payment in pounds has no cash given: its amount is what it pays');
                if (input.changeLbpCents !== undefined) throw new ValidationError('A payment in pounds has no change');
                if (!fx) throw new ConflictError('The exchange rate is not set: a manager has to set it before a payment in pounds');
                const lbp = usdCentsToLbp(input.amountCents, fx);
                if (lbp < 1) throw new ValidationError('This amount is too small to be paid in pounds');
                return new SalePayment('cash', input.amountCents, input.amountCents, null, receivedBy, 'LBP', lbp, fx.rate);
            }
            const tendered = input.tenderedCents ?? input.amountCents;
            if (!Number.isInteger(tendered) || tendered < input.amountCents) throw new ValidationError('The cash given cannot be less than the cash amount');
            const changeLbpCents = input.changeLbpCents ?? 0;
            if (!Number.isInteger(changeLbpCents) || changeLbpCents < 0) throw new ValidationError('changeLbp cannot be negative');
            if (changeLbpCents > tendered - input.amountCents) throw new ValidationError('The change given in pounds cannot be more than the change: cash given minus the amount');
            if (changeLbpCents > 0) {
                if (!fx) throw new ConflictError('The exchange rate is not set: a manager has to set it before change in pounds');
                const changeLbp = usdCentsToLbp(changeLbpCents, fx);
                if (changeLbp < 1) throw new ValidationError('This change is too small to be given in pounds');
                return new SalePayment('cash', input.amountCents, tendered, null, receivedBy, 'USD', null, fx.rate, changeLbpCents, changeLbp);
            }
            return new SalePayment('cash', input.amountCents, tendered, null, receivedBy);
        }
        if (input.method === 'whish') {
            if (input.currency !== undefined && input.currency !== 'USD') throw new ValidationError('Whish is in dollars only');
            if (input.changeLbpCents !== undefined) throw new ValidationError('A Whish payment has no change');
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