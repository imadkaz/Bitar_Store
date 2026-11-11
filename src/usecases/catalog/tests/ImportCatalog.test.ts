import { describe, expect, it } from 'vitest';
import { parseCsv, planImport, readRows } from '../ImportCatalog';

const HEADER = 'model_code,product_name,category,sku,color,size,unit_cost_usd_est,sell_price_usd,material_as_written';
const csv = (...lines: string[]) => [HEADER, ...lines].join('\n');
const plan = (text: string, styles: string[] = [], skus: string[] = []) => { const { rows } = readRows(text); return planImport(rows, new Set(styles), new Set(skus)); };

describe('reading the CSV', () => {
    it('handles quotes, commas inside a field, doubled quotes, CRLF, the BOM and blank lines', () => {
        expect(parseCsv('\uFEFFa,"b, c","say ""hi"""\r\n\r\nx,y,z\r\n')).toEqual([['a', 'b, c', 'say "hi"'], ['x', 'y', 'z']]);
        expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
    });

    it('needs every column, in any order, and says which one is missing', () => {
        expect(readRows('model_code,sku\nA,B').problems[0]).toMatch(/no column: .*product_name/);
        expect(readRows('').problems).toEqual(['The file is empty']);
        const reordered = readRows('sku,model_code,product_name,category,color,size,unit_cost_usd_est,sell_price_usd,material_as_written\nBF-1-S,BF-1,Dress,Dress,Red,S,5,10,Linen');
        expect(reordered.rows[0]).toMatchObject({ modelCode: 'BF-1', sku: 'BF-1-S', sellPrice: '10', unitCost: '5', line: 2 });
    });
});

describe('planning the import with the rules of the app', () => {
    const good = csv('bf-001,Basic-line 1,Pajama,bf-001-c01-s,Blue,S,12,30,Oisho', 'BF-001,Basic-line 1,Pajama,BF-001-C01-M,Blue,M,12,30,Oisho', 'BF-002,L & K,Pants,BF-002-C01-36,Jeans,36,8,20,Jeans');

    it('styles and skus are normalized (upper case), grouped by model, with the prices and costs in cents', () => {
        const p = plan(good);
        expect(p.invalid).toEqual([]);
        expect(p.styles).toEqual([{ code: 'BF-001', name: 'Basic-line 1', category: 'Pajama', skus: 2 }, { code: 'BF-002', name: 'L & K', category: 'Pants', skus: 1 }]);
        expect(p.skus.map((s) => [s.skuCode, s.size, s.priceCents, s.costCents])).toEqual([['BF-001-C01-S', 'S', 3000, 1200], ['BF-001-C01-M', 'M', 3000, 1200], ['BF-002-C01-36', '36', 2000, 800]]);
    });

    it('a row with no selling price is NOT imported (never an invented price); its model is not created if nothing else of it comes in', () => {
        const p = plan(csv('BF-009,Mary Rose,Dress,BF-009-C01-S,Pink,S,18,,Linen', 'BF-009,Mary Rose,Dress,BF-009-C01-M,Pink,M,18,,Linen', 'BF-001,Basic-line 1,Pajama,BF-001-C01-S,Blue,S,12,30,Oisho'));
        expect(p.withoutPrice.map((r) => r.sku)).toEqual(['BF-009-C01-S', 'BF-009-C01-M']);
        expect(p.styles.map((s) => s.code)).toEqual(['BF-001']);
        expect(p.skus).toHaveLength(1);
        expect(p.invalid).toEqual([]);
    });

    it('what is already in the database is reused (the style) or skipped (the sku), never changed', () => {
        const p = plan(good, ['BF-001'], ['BF-001-C01-S']);
        expect(p.existingSkus).toEqual(['BF-001-C01-S']);
        expect(p.existingStyles).toEqual(['BF-001']);
        expect(p.styles.map((s) => s.code)).toEqual(['BF-002']);
        expect(p.skus.map((s) => s.skuCode)).toEqual(['BF-001-C01-M', 'BF-002-C01-36']);
    });

    it('what the app would refuse is reported with its line: bad characters, too long, a bad price, a price of zero, a duplicate sku, a model with two names', () => {
        const p = plan(csv(
            'BF 001,Name,Cat,BF-001-S,Blue,S,1,10,x',                         // line 2: a space in the style code
            'BF-002,Name,Cat,BF 002-S,Blue,S,1,10,x',                         // line 3: a space in the sku code
            `BF-003,${'x'.repeat(121)},Cat,BF-003-S,Blue,S,1,10,x`,           // line 4: a name that is too long
            'BF-004,Name,Cat,BF-004-S,Blue,S,1,ten,x',                        // line 5: a price that is not a number
            'BF-005,Name,Cat,BF-005-S,Blue,S,1,0,x',                          // line 6: a price of zero
            'BF-006,Name,Cat,BF-006-S,Blue,S,1,10,x', 'BF-006,Name,Cat,BF-006-S,Red,M,1,10,x',   // line 8: the same sku code again
            'BF-007,One,Cat,BF-007-S,Blue,S,1,10,x', 'BF-007,Two,Cat,BF-007-M,Blue,M,1,10,x',    // line 10: the same model with another name
            'BF-008,Name,Cat,BF-008-S,Blue,S,-3,10,x',                        // line 11: a negative cost
            'BF-010,Name,Cat,BF-010-S,Blue,,1,10,x',                          // line 12: no size
        ));
        const lines = p.invalid.map((r) => r.line).sort((a, b) => a - b);
        expect(lines).toEqual([2, 3, 4, 5, 6, 8, 10, 11, 12]);
        expect(p.invalid.find((r) => r.line === 8)!.reason).toMatch(/already on line 7/);
        expect(p.invalid.find((r) => r.line === 10)!.reason).toMatch(/BF-007 is "One".*but "Two"/);
    });

    it('a cost above the price is a warning, not a refusal; a missing cost is fine', () => {
        const p = plan(csv('BF-001,Dress,Dress,BF-001-S,Blue,S,50,30,x', 'BF-001,Dress,Dress,BF-001-M,Blue,M,,30,x'));
        expect(p.invalid).toEqual([]);
        expect(p.warnings).toEqual([expect.stringContaining('the cost 50 is above the price 30')]);
        expect(p.skus.map((s) => s.costCents)).toEqual([5000, null]);
    });
});
