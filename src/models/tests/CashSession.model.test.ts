import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { expectedCashCents, isLateClosing, parseCashMovement, parseCloseSession, parseCorrection, parseHandover, parseOpenSession, parseReview } from '../CashSession.model';

describe('the cash session requests', () => {
    it('opening needs the branch and the counted cash (zero is allowed)', () => {
        const branchId = randomUUID();
        expect(parseOpenSession({ branchId, openingCash: '100.50', note: ' float ' })).toEqual({ branchId, openingCents: 10050, note: 'float' });
        expect(parseOpenSession({ branchId, openingCash: 0 })).toEqual({ branchId, openingCents: 0, note: null });
        for (const body of [{}, { branchId }, { branchId: 'abc', openingCash: 1 }, { branchId, openingCash: -1 }, { branchId, openingCash: '1.005' }, { branchId, openingCash: 1_000_000.01 }, { branchId, openingCash: 1, note: 'x'.repeat(201) }, undefined, 'x']) {
            expect(() => parseOpenSession(body), JSON.stringify(body)).toThrow(ValidationError);
        }
    });

    it('a cash movement is in or out, more than zero, with a reason', () => {
        expect(parseCashMovement({ direction: 'in', amount: '20', reason: ' Change from the bank ' })).toEqual({ direction: 'in', amountCents: 2000, reason: 'Change from the bank' });
        expect(parseCashMovement({ direction: 'out', amount: 5.5, reason: 'Manager collected' }).amountCents).toBe(550);
        for (const body of [{}, { direction: 'sideways', amount: 1, reason: 'abc' }, { direction: 'in', amount: 0, reason: 'abc' }, { direction: 'in', amount: -3, reason: 'abc' }, { direction: 'in', amount: 1 }, { direction: 'in', amount: 1, reason: 'ab' }, { direction: 'in', amount: 1, reason: 'x'.repeat(201) }]) {
            expect(() => parseCashMovement(body), JSON.stringify(body)).toThrow(ValidationError);
        }
    });

    it('a handover is the cash counted by who takes the drawer; a closing adds what is taken out and the explanation', () => {
        expect(parseHandover({ countedCash: '350.00', note: 'Counted twice' })).toEqual({ countedCents: 35000, note: 'Counted twice' });
        expect(() => parseHandover({})).toThrow(ValidationError);
        expect(parseCloseSession({ countedCash: '500', cashRemoved: '400' })).toEqual({ countedCents: 50000, removedCents: 40000, differenceNote: null });
        expect(parseCloseSession({ countedCash: 10, differenceNote: 'Short by one coin' }).differenceNote).toBe('Short by one coin');
        for (const body of [{}, { countedCash: 10, cashRemoved: 11 }, { countedCash: -1 }, { countedCash: 'ten' }]) expect(() => parseCloseSession(body), JSON.stringify(body)).toThrow(ValidationError);
    });

    it('a correction names the field, the new value and a reason; a review has an optional note', () => {
        expect(parseCorrection({ field: 'countedCash', value: '345', reason: 'Mistyped count' })).toEqual({ field: 'counted_cash', valueCents: 34500, reason: 'Mistyped count' });
        expect(parseCorrection({ field: 'openingCash', value: 0, reason: 'Wrong opening' }).field).toBe('opening_cash');
        for (const body of [{}, { field: 'total', value: 1, reason: 'abc' }, { field: 'countedCash', reason: 'abc' }, { field: 'countedCash', value: 1, reason: 'ab' }]) expect(() => parseCorrection(body), JSON.stringify(body)).toThrow(ValidationError);
        expect(parseReview({ note: ' Checked with the owner ' })).toEqual({ note: 'Checked with the owner' });
        expect(parseReview(undefined)).toEqual({ note: null });
    });

    it('the expected cash is the opening plus the cash payments plus what was added minus what was taken: Whish is not in it', () => {
        expect(expectedCashCents({ openingCents: 10000, cashPaymentsCents: 35000, cashInCents: 2000, cashOutCents: 5000 })).toBe(42000);
        expect(expectedCashCents({ openingCents: 0, cashPaymentsCents: 0, cashInCents: 0, cashOutCents: 0 })).toBe(0);
    });

    it('a session closed on another shop day than it was opened is a late closing', () => {
        expect(isLateClosing(new Date('2026-11-05T08:00:00Z'), new Date('2026-11-05T18:00:00Z'))).toBe(false);
        expect(isLateClosing(new Date('2026-11-05T08:00:00Z'), new Date('2026-11-06T08:00:00Z'))).toBe(true);
        expect(isLateClosing(new Date('2026-11-05T20:00:00Z'), new Date('2026-11-05T23:30:00Z'))).toBe(true);        // 22:30 to 01:30 Beirut: past midnight
    });
});
