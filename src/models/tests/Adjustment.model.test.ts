import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { parseAdjustment, planAdjustment } from '../Adjustment.model';

const body = (patch: Record<string, unknown> = {}) => ({ branchId: randomUUID(), skuId: randomUUID(), quantityDelta: -2, reason: 'count_correction', note: 'Counted 8, the system had 10', ...patch });

describe('parseAdjustment', () => {
    it('takes the sellable stock by default and trims the note', () => {
        const parsed = parseAdjustment(body({ note: '  Counted 8, the system had 10  ' }));
        expect(parsed).toMatchObject({ bucket: 'sellable', quantityDelta: -2, reason: 'count_correction', note: 'Counted 8, the system had 10' });
        expect(parseAdjustment(body({ bucket: 'non_sellable' })).bucket).toBe('non_sellable');
    });

    it('refuses everything else', () => {
        const bad: Record<string, unknown>[] = [
            { branchId: 'abc' }, { skuId: 5 }, { bucket: 'in_transit' }, { bucket: 'reserved' }, { quantityDelta: 0 }, { quantityDelta: 1.5 }, { quantityDelta: '3' },
            { quantityDelta: 100_001 }, { quantityDelta: -100_001 }, { reason: 'because' }, { reason: undefined }, { note: '' }, { note: 'abc' }, { note: '    ' }, { note: 'x'.repeat(201) }, { note: 5 },
        ];
        for (const patch of bad) expect(() => parseAdjustment(body(patch)), JSON.stringify(patch)).toThrow(ValidationError);
        for (const input of [undefined, null, 'x', [], 5]) expect(() => parseAdjustment(input), String(input)).toThrow(ValidationError);
    });
});

describe('planAdjustment: what the stock does', () => {
    const plan = (patch: Record<string, unknown>) => planAdjustment(parseAdjustment(body(patch)));

    it('a correction goes either way, in the bucket asked', () => {
        expect(plan({ quantityDelta: -2 })).toEqual([{ bucket: 'sellable', delta: -2 }]);
        expect(plan({ quantityDelta: 3, reason: 'data_entry_error' })).toEqual([{ bucket: 'sellable', delta: 3 }]);
        expect(plan({ quantityDelta: -1, bucket: 'non_sellable', reason: 'other' })).toEqual([{ bucket: 'non_sellable', delta: -1 }]);
    });

    it('"found" only adds, "loss" only takes out', () => {
        expect(plan({ reason: 'found', quantityDelta: 4 })).toEqual([{ bucket: 'sellable', delta: 4 }]);
        expect(() => plan({ reason: 'found', quantityDelta: -4 })).toThrow('adds pieces');
        expect(plan({ reason: 'loss', quantityDelta: -1 })).toEqual([{ bucket: 'sellable', delta: -1 }]);
        expect(() => plan({ reason: 'loss', quantityDelta: 1 })).toThrow('takes pieces out');
    });

    it('"damage" takes the pieces off sale and puts them ON HOLD; when they are already on hold it writes them off', () => {
        expect(plan({ reason: 'damage', quantityDelta: -3 })).toEqual([{ bucket: 'sellable', delta: -3 }, { bucket: 'non_sellable', delta: 3 }]);
        expect(plan({ reason: 'damage', quantityDelta: -3, bucket: 'non_sellable' })).toEqual([{ bucket: 'non_sellable', delta: -3 }]);
        expect(() => plan({ reason: 'damage', quantityDelta: 3 })).toThrow('takes pieces out');
    });
});
