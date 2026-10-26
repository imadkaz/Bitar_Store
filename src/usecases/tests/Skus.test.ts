import { beforeEach, describe, expect, it } from 'vitest';
import { makeCatalog, makeSku, makeStyle } from '../../test-helpers/catalogFakes';
import { ConflictError } from '../../utils/exeptions/ConflictError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { AddBarcodeUsecase } from '../barcodes/AddBarcodeUsecase';
import { ChangeSkuPriceUsecase } from '../skus/ChangeSkuPriceUsecase';
import { CreateSkuUsecase } from '../skus/CreateSkuUsecase';
import { GetPriceHistoryUsecase } from '../skus/GetPriceHistoryUsecase';
import { ListSkusUsecase } from '../skus/ListSkusUsecase';
import { LookupSkuUsecase } from '../skus/LookupSkuUsecase';
import { RemoveBarcodeUsecase } from '../barcodes/RemoveBarcodeUsecase';
import { UpdateSkuUsecase } from '../skus/UpdateSkuUsecase';

describe('sku use cases', () => {
    let c: ReturnType<typeof makeCatalog>;
    let styleId: string;
    const base = () => ({ styleId, skuCode: ' nk-100-m-red ', size: ' M ', color: ' Red ', standardPrice: '25' });

    beforeEach(async () => {
        c = makeCatalog();
        const style = makeStyle();
        await c.styles.save(style, 'creator');
        styleId = style.getId();
    });

    describe('CreateSkuUsecase', () => {
        it('creates the sku with a normalized code, exact cents, USD by default, and writes its FIRST price-history row', async () => {
            const sku = await new CreateSkuUsecase(c.styles, c.skus).execute(base(), 'manager-1');
            expect(sku.getSkuCode()).toBe('NK-100-M-RED');
            expect(sku.getSize()).toBe('M');
            expect(sku.getStandardPriceCents()).toBe(2500);
            expect(sku.getCurrency()).toBe('USD');
            expect(c.skus.history).toEqual([expect.objectContaining({ skuId: sku.getId(), oldPriceCents: null, newPriceCents: 2500, changedBy: 'manager-1' })]);
        });

        it('turns a decimal price into exact cents without floating point drift', async () => {
            const useCase = new CreateSkuUsecase(c.styles, c.skus);
            const sizes = ['A', 'B', 'C', 'D'];
            const prices: [number | string, number][] = [[19.99, 1999], ['0.07', 7], ['1234567.89', 123456789], [0.29, 29]];
            for (const [i, [price, cents]] of prices.entries()) {
                const sku = await useCase.execute({ ...base(), skuCode: `P${i}`, size: sizes[i], standardPrice: price }, 'm');
                expect(sku.getStandardPriceCents()).toBe(cents);
            }
        });

        it('refuses an unknown style (404), an inactive style (409), a duplicate code or variant (409)', async () => {
            const useCase = new CreateSkuUsecase(c.styles, c.skus);
            await expect(useCase.execute({ ...base(), styleId: 'nobody' }, 'm')).rejects.toBeInstanceOf(NotFoundError);
            await useCase.execute(base(), 'm');
            await expect(useCase.execute({ ...base(), size: 'L' }, 'm')).rejects.toBeInstanceOf(ConflictError);                 // same code
            await expect(useCase.execute({ ...base(), skuCode: 'OTHER', size: 'm', color: ' RED' }, 'm')).rejects.toBeInstanceOf(ConflictError);   // same variant
            const inactive = makeStyle({ isActive: false });
            await c.styles.save(inactive, 'c');
            await expect(useCase.execute({ ...base(), styleId: inactive.getId(), skuCode: 'NEW' }, 'm')).rejects.toBeInstanceOf(ConflictError);
        });

        it('turns every bad input into a ValidationError and writes nothing', async () => {
            const useCase = new CreateSkuUsecase(c.styles, c.skus);
            const bad = [{ skuCode: undefined }, { skuCode: 'has space' }, { size: undefined }, { size: ' ' }, { color: '' }, { standardPrice: undefined }, { standardPrice: 'abc' }, { standardPrice: -1 }, { standardPrice: 1.234 }, { currency: 'EURO' }];
            for (const patch of bad) await expect(useCase.execute({ ...base(), ...patch } as never, 'm')).rejects.toBeInstanceOf(ValidationError);
            expect(c.skus.items.size).toBe(0);
            expect(c.skus.history).toHaveLength(0);
        });
    });

    describe('UpdateSkuUsecase', () => {
        it('SAVES size, color and the active flag, and never touches the price or the code', async () => {
            const sku = makeSku(styleId, { size: 'M', color: 'Red', standardPriceCents: 2500 });
            await c.skus.save(sku, 'creator');
            await new UpdateSkuUsecase(c.skus).execute({ id: sku.getId(), size: 'XL', color: 'Green', isActive: false }, 'editor');
            const stored = (await c.skus.findById(sku.getId()))!;
            expect([stored.getSize(), stored.getColor(), stored.isActive(), stored.getStandardPriceCents(), stored.getSkuCode()]).toEqual(['XL', 'Green', false, 2500, sku.getSkuCode()]);
            expect(c.skus.audit.get(sku.getId())).toEqual({ createdBy: 'creator', updatedBy: 'editor' });
        });

        it('a sku never conflicts with ITSELF, but cannot move onto another sku\'s variant', async () => {
            const a = makeSku(styleId, { size: 'M', color: 'Red' });
            const b = makeSku(styleId, { size: 'L', color: 'Red' });
            await c.skus.save(a, 'c');
            await c.skus.save(b, 'c');
            const useCase = new UpdateSkuUsecase(c.skus);
            await expect(useCase.execute({ id: a.getId(), size: 'M', color: 'Red' }, 'e')).resolves.toBeDefined();   // its own variant again: fine
            await expect(useCase.execute({ id: a.getId(), size: 'L' }, 'e')).rejects.toBeInstanceOf(ConflictError);
            expect((await c.skus.findById(a.getId()))?.getSize()).toBe('M');                                         // refused: nothing changed
        });

        it('404, and 400 for bad values', async () => {
            const sku = makeSku(styleId);
            await c.skus.save(sku, 'c');
            const useCase = new UpdateSkuUsecase(c.skus);
            await expect(useCase.execute({ id: 'nobody', size: 'S' }, 'e')).rejects.toBeInstanceOf(NotFoundError);
            await expect(useCase.execute({ id: sku.getId(), isActive: 'no' as never }, 'e')).rejects.toBeInstanceOf(ValidationError);
            await expect(useCase.execute({ id: sku.getId(), size: '' }, 'e')).rejects.toBeInstanceOf(ValidationError);
        });
    });

    describe('ChangeSkuPriceUsecase and GetPriceHistoryUsecase', () => {
        it('records old and new price and who changed it; the same price records nothing', async () => {
            const sku = makeSku(styleId, { standardPriceCents: 2500 });
            await c.skus.save(sku, 'creator');
            const useCase = new ChangeSkuPriceUsecase(c.skus);

            const changed = await useCase.execute(sku.getId(), '30.50', 'manager-1');
            expect(changed.getStandardPriceCents()).toBe(3050);
            await useCase.execute(sku.getId(), 30.5, 'manager-1');                       // same price again
            expect(c.skus.history.map((h) => [h.oldPriceCents, h.newPriceCents, h.changedBy])).toEqual([[null, 2500, 'creator'], [2500, 3050, 'manager-1']]);

            const history = await new GetPriceHistoryUsecase(c.skus).execute(sku.getId());
            expect(history.map((h) => h.newPriceCents)).toEqual([3050, 2500]);           // newest first
            expect(await new GetPriceHistoryUsecase(c.skus).execute(sku.getId(), 1)).toHaveLength(1);
        });

        it('404 for an unknown sku, 400 for a bad price, and a bad price changes nothing', async () => {
            const sku = makeSku(styleId, { standardPriceCents: 2500 });
            await c.skus.save(sku, 'c');
            const useCase = new ChangeSkuPriceUsecase(c.skus);
            await expect(useCase.execute('nobody', '5', 'm')).rejects.toBeInstanceOf(NotFoundError);
            for (const price of ['abc', -5, '1.999', undefined, null, '']) await expect(useCase.execute(sku.getId(), price as string | number, 'm')).rejects.toBeInstanceOf(ValidationError);
            expect((await c.skus.findById(sku.getId()))?.getStandardPriceCents()).toBe(2500);
            expect(c.skus.history).toHaveLength(1);
            await expect(new GetPriceHistoryUsecase(c.skus).execute('nobody')).rejects.toBeInstanceOf(NotFoundError);
        });
    });

    describe('ListSkusUsecase', () => {
        it('searches by sku code, color or style name, filters by style, hides inactive, and pages', async () => {
            const jacket = makeStyle({ name: 'Rain Jacket' });
            await c.styles.save(jacket, 'c');
            const a = makeSku(styleId, { skuCode: 'A-1', color: 'Crimson', size: 'S' });
            const b = makeSku(jacket.getId(), { skuCode: 'B-1', color: 'Navy', isActive: false });
            await c.skus.save(a, 'c');
            await c.skus.save(b, 'c');
            const useCase = new ListSkusUsecase(c.skus);
            expect((await useCase.execute({ search: 'crimson' })).map((r) => r.sku.getSkuCode())).toEqual(['A-1']);
            expect((await useCase.execute({ search: 'rain' })).map((r) => r.sku.getSkuCode())).toEqual(['B-1']);
            expect((await useCase.execute({ search: 'b-1' })).map((r) => r.style.getName())).toEqual(['Rain Jacket']);
            expect((await useCase.execute({ styleId })).map((r) => r.sku.getSkuCode())).toEqual(['A-1']);
            expect((await useCase.execute({ activeOnly: true })).map((r) => r.sku.getSkuCode())).toEqual(['A-1']);
            expect(await useCase.execute({ limit: 1, offset: 5 })).toEqual([]);
            await expect(useCase.execute({ limit: 0 })).rejects.toBeInstanceOf(ValidationError);
        });
    });

    describe('barcodes and LookupSkuUsecase', () => {
        it('adds a barcode (trimmed), refuses duplicates, and removes it', async () => {
            const sku = makeSku(styleId);
            await c.skus.save(sku, 'c');
            const add = new AddBarcodeUsecase(c.skus, c.barcodes);
            const barcode = await add.execute(sku.getId(), ' 5901234123457 ', 'm');
            expect(barcode.getCode()).toBe('5901234123457');
            await expect(add.execute(sku.getId(), '5901234123457', 'm')).rejects.toBeInstanceOf(ConflictError);
            await expect(add.execute('nobody', '111', 'm')).rejects.toBeInstanceOf(NotFoundError);
            for (const bad of [undefined, '', 'has space', 'x'.repeat(65), 5]) await expect(add.execute(sku.getId(), bad as string , 'm')).rejects.toBeInstanceOf(ValidationError);

            const remove = new RemoveBarcodeUsecase(c.barcodes);
            await remove.execute(barcode.getId());
            expect(await c.barcodes.findById(barcode.getId())).toBeNull();
            await expect(remove.execute(barcode.getId())).rejects.toBeInstanceOf(NotFoundError);
        });

        it('lookup finds a sku by barcode first, then by sku code, and tells the scanner when nothing matches', async () => {
            const sku = makeSku(styleId, { skuCode: 'NK-1' });
            const other = makeSku(styleId, { skuCode: 'NK-2', size: 'L' });
            await c.skus.save(sku, 'c');
            await c.skus.save(other, 'c');
            await new AddBarcodeUsecase(c.skus, c.barcodes).execute(sku.getId(), '5901234123457', 'm');
            // a barcode that LOOKS like another sku's code still resolves to the sku that owns the barcode
            await new AddBarcodeUsecase(c.skus, c.barcodes).execute(sku.getId(), 'NK-2', 'm');

            const lookup = new LookupSkuUsecase(c.skus, c.barcodes);
            expect((await lookup.execute('5901234123457')).sku.getSkuCode()).toBe('NK-1');
            expect((await lookup.execute(' nk-1 ')).sku.getSkuCode()).toBe('NK-1');
            expect((await lookup.execute('NK-2')).sku.getSkuCode()).toBe('NK-1');
            const detail = await lookup.execute('5901234123457');
            expect(detail.barcodes.map((b) => b.getCode()).sort()).toEqual(['5901234123457', 'NK-2']);
            expect(detail.style.getId()).toBe(styleId);
            await expect(lookup.execute('0000')).rejects.toBeInstanceOf(NotFoundError);
            await expect(lookup.execute('!!!')).rejects.toBeInstanceOf(NotFoundError);
            for (const bad of [undefined, '', '   ', 5]) await expect(lookup.execute(bad as string)).rejects.toBeInstanceOf(ValidationError);
        });
    });
});
