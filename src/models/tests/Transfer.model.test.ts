import { describe, expect, it } from 'vitest';
import { ConflictError } from '../../utils/exeptions/ConflictError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { Transfer } from '../Transfer.model';

const WH = 'warehouse-1';
const HAMRA = 'hamra-1';
const DRESS = 'sku-dress';
const CAP = 'sku-cap';

const draft = (lines = [{ skuId: DRESS, quantity: 10 }, { skuId: CAP, quantity: 4 }]) => Transfer.create({ id: 't1', sourceBranchId: WH, destinationBranchId: HAMRA, requestedBy: 'u1', lines });
const line = (t: Transfer, skuId: string) => t.getLines().find((l) => l.skuId === skuId)!;
const sum = (moves: { branchId: string; bucket: string; delta: number; skuId: string }[], branchId: string, bucket: string, skuId = DRESS) =>
    moves.filter((m) => m.branchId === branchId && m.bucket === bucket && m.skuId === skuId).reduce((s, m) => s + m.delta, 0);

describe('Transfer: creating a draft', () => {
    it('is a draft, with nothing sent yet', () => {
        const t = draft();
        expect(t.getStatus()).toBe('draft');
        expect(t.getLines().map((l) => [l.requestedQty, l.dispatchedQty, l.receivedQty, l.resolvedQty])).toEqual([[10, 0, 0, 0], [4, 0, 0, 0]]);
    });

    it('needs two different places, 1 to 50 lines, each sku once, whole quantities from 1 to 10000', () => {
        const make = (patch: object) => () => Transfer.create({ id: 't', sourceBranchId: WH, destinationBranchId: HAMRA, requestedBy: 'u', lines: [{ skuId: DRESS, quantity: 1 }], ...patch });
        expect(make({})).not.toThrow();
        expect(make({ destinationBranchId: WH })).toThrow('two different places');
        expect(make({ lines: [] })).toThrow(ValidationError);
        expect(make({ lines: Array.from({ length: 51 }, (_, i) => ({ skuId: `s${i}`, quantity: 1 })) })).toThrow(ValidationError);
        expect(make({ lines: [{ skuId: DRESS, quantity: 1 }, { skuId: DRESS, quantity: 2 }] })).toThrow('only once');
        for (const quantity of [0, -1, 1.5, 10_001, NaN]) expect(make({ lines: [{ skuId: DRESS, quantity }] }), String(quantity)).toThrow(ValidationError);
        expect(make({ note: 'x'.repeat(501) })).toThrow(ValidationError);
        expect(make({ note: 5 })).toThrow(ValidationError);
    });
});

describe('Transfer: dispatch', () => {
    it('takes the pieces off the sender and puts them "on the road to" the destination', () => {
        const t = draft();
        const moves = t.dispatch();
        expect(t.getStatus()).toBe('dispatched');
        expect(sum(moves, WH, 'sellable')).toBe(-10);
        expect(sum(moves, HAMRA, 'in_transit')).toBe(10);
        expect(sum(moves, WH, 'sellable', CAP)).toBe(-4);
        expect(t.getLines().map((l) => l.dispatchedQty)).toEqual([10, 4]);
        expect(moves.every((m) => m.type === 'transfer_dispatch')).toBe(true);
    });

    it('can send less than asked on some lines (the warehouse is short), or nothing on a line', () => {
        const t = draft();
        const moves = t.dispatch([{ skuId: DRESS, quantity: 6 }, { skuId: CAP, quantity: 0 }]);
        expect([line(t, DRESS).dispatchedQty, line(t, CAP).dispatchedQty]).toEqual([6, 0]);
        expect(moves.map((m) => m.skuId)).not.toContain(CAP);
        expect(sum(moves, HAMRA, 'in_transit')).toBe(6);
    });

    it('refuses: more than asked, an unknown sku, a repeat, a negative number, sending nothing at all', () => {
        for (const only of [[{ skuId: DRESS, quantity: 11 }], [{ skuId: 'other', quantity: 1 }], [{ skuId: DRESS, quantity: 1 }, { skuId: DRESS, quantity: 2 }], [{ skuId: DRESS, quantity: -1 }], [{ skuId: DRESS, quantity: 0 }, { skuId: CAP, quantity: 0 }]]) {
            expect(() => draft().dispatch(only), JSON.stringify(only)).toThrow(ValidationError);
        }
    });

    it('happens once: a second dispatch, or a dispatch of a cancelled transfer, is refused', () => {
        const t = draft();
        t.dispatch();
        expect(() => t.dispatch()).toThrow(ConflictError);
        const c = draft();
        c.cancel();
        expect(() => c.dispatch()).toThrow(ConflictError);
    });
});

describe('Transfer: receiving', () => {
    const sent = () => { const t = draft(); t.dispatch(); return t; };

    it('good pieces go on sale at the destination, damaged ones to hold, and what arrived leaves the road', () => {
        const t = sent();
        const moves = t.receive([{ skuId: DRESS, accepted: 8, damaged: 1 }]);
        expect(sum(moves, HAMRA, 'in_transit')).toBe(-9);
        expect(sum(moves, HAMRA, 'sellable')).toBe(8);
        expect(sum(moves, HAMRA, 'non_sellable')).toBe(1);
        expect(line(t, DRESS).receivedQty).toBe(9);
        expect(t.getStatus()).toBe('partially_received');        // 1 dress and the caps are still out
    });

    it('everything arrives (maybe in two rounds): received', () => {
        const t = sent();
        t.receive([{ skuId: DRESS, accepted: 10 }]);
        expect(t.getStatus()).toBe('partially_received');
        t.receive([{ skuId: CAP, accepted: 4 }]);
        expect(t.getStatus()).toBe('received');
        expect(t.totalOutstanding()).toBe(0);
    });

    it('cannot receive more than is on the road, nor twice what was already received', () => {
        const t = sent();
        expect(() => t.receive([{ skuId: DRESS, accepted: 11 }])).toThrow('Only 10 are still on the way');
        t.receive([{ skuId: DRESS, accepted: 6 }]);
        expect(() => t.receive([{ skuId: DRESS, accepted: 5 }])).toThrow('Only 4 are still on the way');
        expect(() => t.receive([{ skuId: DRESS, accepted: 3, damaged: 2 }])).toThrow(ConflictError);
    });

    it('refuses a draft, a cancelled transfer, empty lines, unknown skus, repeats, negative or empty quantities', () => {
        expect(() => draft().receive([{ skuId: DRESS, accepted: 1 }])).toThrow(ConflictError);
        const bad = [[], [{ skuId: 'other', accepted: 1 }], [{ skuId: DRESS, accepted: 1 }, { skuId: DRESS, accepted: 1 }], [{ skuId: DRESS, accepted: -1 }], [{ skuId: DRESS, accepted: 0 }], [{ skuId: DRESS, accepted: 1.5 }]];
        for (const items of bad) expect(() => sent().receive(items), JSON.stringify(items)).toThrow(ValidationError);
    });
});

describe('Transfer: what never arrived', () => {
    it('a manager confirms the loss with a reason: it leaves the road, and the transfer is closed', () => {
        const t = draft([{ skuId: DRESS, quantity: 10 }]);
        t.dispatch();
        t.receive([{ skuId: DRESS, accepted: 9 }]);
        expect(t.getStatus()).toBe('partially_received');
        const moves = t.resolve('One dress lost by the courier');
        expect(moves).toEqual([{ skuId: DRESS, branchId: HAMRA, bucket: 'in_transit', delta: -1, type: 'transfer_resolution', reason: 'One dress lost by the courier' }]);
        expect(t.getStatus()).toBe('closed');
        expect(line(t, DRESS).resolvedQty).toBe(1);
    });

    it('can resolve one line only, and a line only up to what is still out', () => {
        const t = draft();
        t.dispatch();
        t.resolve('Box never came', [{ skuId: CAP, quantity: 4 }]);
        expect(t.getStatus()).toBe('partially_received');
        expect(() => t.resolve('too many', [{ skuId: DRESS, quantity: 11 }])).toThrow(ConflictError);
    });

    it('needs a reason, a transfer that is on the road, and something outstanding', () => {
        const t = draft();
        t.dispatch();
        for (const reason of [undefined, '', '  ', 'ab', 'x'.repeat(201), 5]) expect(() => t.resolve(reason), String(reason)).toThrow(ValidationError);
        expect(() => draft().resolve('not sent yet')).toThrow(ConflictError);
        const done = draft([{ skuId: DRESS, quantity: 2 }]);
        done.dispatch();
        done.receive([{ skuId: DRESS, accepted: 2 }]);
        expect(done.getStatus()).toBe('received');
        expect(() => done.resolve('nothing is lost')).toThrow(ConflictError);
    });
});

describe('Transfer: cancel', () => {
    it('only a draft can be cancelled', () => {
        const t = draft();
        t.cancel();
        expect(t.getStatus()).toBe('cancelled');
        expect(() => t.cancel()).toThrow(ConflictError);
        const sent = draft();
        sent.dispatch();
        expect(() => sent.cancel()).toThrow(ConflictError);
    });
});

describe('Transfer: the numbers always add up', () => {
    it('across a whole life: what was sent = arrived + lost + still on the road, and the moves net out', () => {
        const t = draft([{ skuId: DRESS, quantity: 10 }]);
        const all = [...t.dispatch(), ...t.receive([{ skuId: DRESS, accepted: 5, damaged: 1 }]), ...t.receive([{ skuId: DRESS, accepted: 2 }]), ...t.resolve('lost')];
        const l = line(t, DRESS);
        expect(l.dispatchedQty).toBe(l.receivedQty + l.resolvedQty + t.outstanding(l));
        expect([l.receivedQty, l.resolvedQty, t.outstanding(l)]).toEqual([8, 2, 0]);
        // sender -10; destination: on the road +10 -6 -2 -2 = 0, on sale +7, on hold +1  => the 10 pieces are all accounted for (7 + 1 + 2 lost)
        expect(sum(all, WH, 'sellable')).toBe(-10);
        expect(sum(all, HAMRA, 'in_transit')).toBe(0);
        expect(sum(all, HAMRA, 'sellable') + sum(all, HAMRA, 'non_sellable')).toBe(8);
    });
});
