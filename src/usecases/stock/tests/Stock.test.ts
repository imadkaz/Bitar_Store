import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Branch } from '../../../models/Branch.model';
import { Sku } from '../../../models/Sku.model';
import { UserRole } from '../../../models/User.model';
import { FakeBranchRepository } from '../../../test-helpers/fakes';
import { FakeSkuRepository, FakeStyleRepository, FakeBarcodeRepository, makeSku, makeStyle } from '../../../test-helpers/catalogFakes';
import { FakeSalesWorld, FakeStockRepository, makeAuth } from '../../../test-helpers/salesFakes';
import { ForbiddenError } from '../../../utils/exeptions/ForbiddenError';
import { NotFoundError } from '../../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../../utils/exeptions/ValidationError';
import { ListStockUsecase } from '../ListStockUsecase';
import { SetOpeningStockUsecase } from '../SetOpeningStockUsecase';

describe('opening stock and the stock view', () => {
    let world: FakeSalesWorld;
    let hamra: Branch;
    let dress: Sku;
    let cap: Sku;
    let opening: SetOpeningStockUsecase;
    let list: ListStockUsecase;
    const manager = () => makeAuth(UserRole.MANAGER, [hamra.getId()]);

    beforeEach(async () => {
        world = new FakeSalesWorld();
        hamra = Branch.create({ id: randomUUID(), code: 'HAMRA', name: 'Hamra' });
        const styles = new FakeStyleRepository();
        const skus = new FakeSkuRepository(styles, new FakeBarcodeRepository());
        const style = makeStyle({ name: 'Summer Dress' });
        await styles.save(style, 'c');
        dress = makeSku(style.getId(), { size: 'M' });
        cap = makeSku(style.getId(), { size: 'L' });
        await skus.save(dress, 'c');
        await skus.save(cap, 'c');
        const stock = new FakeStockRepository(world);
        opening = new SetOpeningStockUsecase(new FakeBranchRepository([hamra]), skus, stock);
        list = new ListStockUsecase(skus, stock);
    });

    const body = (patch = {}) => ({ branchId: hamra.getId(), lines: [{ skuId: dress.getId(), quantity: 8 }, { skuId: cap.getId(), quantity: 3 }], ...patch });

    it('loads the counted quantities: balances and one "opening" ledger row per sku', async () => {
const result = await opening.execute(body({ lines: [{ skuId: dress.getId(), quantity: 8 }] }), 'opening-key-1', manager());
        expect(result).toMatchObject({ replayed: false, lines: 1 });
        expect(world.quantity(hamra.getId(), dress.getId())).toBe(8);
        expect(world.ledger.map((m) => [m.type, m.delta])).toEqual([['opening', 8]]);
    });

    it('the same request with the same key is not loaded twice (replay); another request with the same key is refused', async () => {
        const auth = manager();
        const first = await opening.execute(body(), 'opening-key-2', auth);
        const again = await opening.execute(body(), 'opening-key-2', auth);
        expect(again).toMatchObject({ replayed: true, batchId: first.batchId });
        expect(world.ledger).toHaveLength(2);
        await expect(opening.execute(body({ lines: [{ skuId: dress.getId(), quantity: 9 }] }), 'opening-key-2', auth)).rejects.toThrow('different request');
        expect(world.quantity(hamra.getId(), dress.getId())).toBe(8);
    });

    it('is only for skus that have NO movement yet at that branch', async () => {
        await opening.execute(body({ lines: [{ skuId: dress.getId(), quantity: 8 }] }), 'opening-key-c', manager());
        await expect(opening.execute(body({ lines: [{ skuId: dress.getId(), quantity: 50 }] }), 'opening-key-6', manager())).rejects.toThrow('no movement yet');
        expect(world.quantity(hamra.getId(), dress.getId())).toBe(8);
    });

    it('needs the adjustments permission, a branch you can reach, and valid input', async () => {
        await expect(opening.execute(body(), 'opening-key-7', makeAuth(UserRole.EMPLOYEE, [hamra.getId()]))).rejects.toBeInstanceOf(ForbiddenError);
        await expect(opening.execute(body(), 'opening-key-8', makeAuth(UserRole.MANAGER, [randomUUID()]))).rejects.toBeInstanceOf(ForbiddenError);
        const admin = makeAuth(UserRole.ADMIN);
        await expect(opening.execute(body({ branchId: randomUUID() }), 'opening-key-9', admin)).rejects.toBeInstanceOf(NotFoundError);
        await expect(opening.execute(body({ lines: [{ skuId: randomUUID(), quantity: 1 }] }), 'opening-key-a', admin)).rejects.toBeInstanceOf(NotFoundError);
        const bad = [undefined, {}, body({ branchId: 'abc' }), body({ lines: [] }), body({ lines: [{ skuId: dress.getId(), quantity: 0 }] }), body({ lines: [{ skuId: dress.getId(), quantity: 1.5 }] }),
            body({ lines: [{ skuId: dress.getId(), quantity: 1 }, { skuId: dress.getId(), quantity: 2 }] }), body({ lines: [{ skuId: 'abc', quantity: 1 }] })];
        for (const input of bad) {
            await expect(opening.execute(input, 'opening-key-b', admin), JSON.stringify(input))
                .rejects.toBeInstanceOf(ValidationError);
        } 
       await expect(opening.execute(body({ lines: [{ skuId: dress.getId(), quantity: 8 }] }), 'short', admin)).rejects.toBeInstanceOf(ValidationError);
        expect(world.ledger).toHaveLength(0);
    });

    it('the stock view lists every catalog variant for ONE branch, with 0 where there is nothing', async () => {
        await opening.execute(body({ lines: [{ skuId: dress.getId(), quantity: 8 }] }), 'opening-key-1', manager());
        const staff = makeAuth(UserRole.EMPLOYEE, [hamra.getId()]);
        const items = await list.execute({ branchId: hamra.getId() }, staff);
        expect(items.map((i) => [i.sku.sku.getSize(), i.level.sellable])).toEqual(expect.arrayContaining([['M', 8], ['L', 0]]));
        expect(items[0].sku.style.getName()).toBe('Summer Dress');
        expect((await list.execute({ branchId: hamra.getId(), search: 'summer' }, staff))).toHaveLength(2);
        expect((await list.execute({ branchId: hamra.getId(), limit: 1 }, staff))).toHaveLength(1);
        await expect(list.execute({ branchId: randomUUID() }, staff)).rejects.toBeInstanceOf(ForbiddenError);
        await expect(list.execute({}, staff)).rejects.toBeInstanceOf(ValidationError);
        await expect(list.execute({ branchId: hamra.getId(), limit: 0 }, staff)).rejects.toBeInstanceOf(ValidationError);
    });
});
