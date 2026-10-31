import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Branch } from '../../../models/Branch.model';
import { Sku } from '../../../models/Sku.model';
import { Style } from '../../../models/Style.model';
import { UserRole } from '../../../models/User.model';
import { FakeBranchRepository } from '../../../test-helpers/fakes';
import { FakeBarcodeRepository, FakeSkuRepository, FakeStyleRepository, makeSku, makeStyle } from '../../../test-helpers/catalogFakes';
import { FakeReorderLevelRepository } from '../../../test-helpers/insightFakes';
import { makeAuth } from '../../../test-helpers/salesFakes';
import { ConflictError } from '../../../utils/exeptions/ConflictError';
import { ForbiddenError } from '../../../utils/exeptions/ForbiddenError';
import { NotFoundError } from '../../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../../utils/exeptions/ValidationError';
import { DeleteReorderLevelUsecase, ListReorderLevelsUsecase, SetReorderLevelForStyleUsecase, SetReorderLevelUsecase } from '../ReorderLevelUsecases';

describe('minimum levels (per branch, per sku or per model)', () => {
    let hamra: Branch;
    let tripoli: Branch;
    let warehouse: Branch;
    let closed: Branch;
    let style: Style;
    let skuM: Sku;
    let skuL: Sku;
    let retired: Sku;
    let levels: FakeReorderLevelRepository;
    let set: SetReorderLevelUsecase;
    let setStyle: SetReorderLevelForStyleUsecase;
    let list: ListReorderLevelsUsecase;
    let remove: DeleteReorderLevelUsecase;

    const admin = () => makeAuth(UserRole.ADMIN);
    const hamraManager = () => makeAuth(UserRole.MANAGER, [hamra.getId()]);
    const body = (patch: Record<string, unknown> = {}) => ({ branchId: hamra.getId(), skuId: skuM.getId(), minQuantity: 5, ...patch });

    beforeEach(async () => {
        hamra = Branch.create({ id: randomUUID(), code: 'HAMRA', name: 'Hamra' });
        tripoli = Branch.create({ id: randomUUID(), code: 'TRIPOLI', name: 'Tripoli' });
        warehouse = Branch.create({ id: randomUUID(), code: 'WH', name: 'Warehouse', kind: 'warehouse' });
        closed = Branch.create({ id: randomUUID(), code: 'OLD', name: 'Old', isActive: false });
        const branches = new FakeBranchRepository([hamra, tripoli, warehouse, closed]);
        const styles = new FakeStyleRepository();
        const skus = new FakeSkuRepository(styles, new FakeBarcodeRepository());
        style = makeStyle({ name: 'Summer Dress' });
        await styles.save(style, 'c');
        skuM = makeSku(style.getId(), { size: 'M' });
        skuL = makeSku(style.getId(), { size: 'L' });
        retired = makeSku(style.getId(), { size: 'XL', isActive: false });
        for (const s of [skuM, skuL, retired]) await skus.save(s, 'c');
        const all = new Map([skuM, skuL, retired].map((s) => [s.getId(), s]));
        levels = new FakeReorderLevelRepository((id) => ({ skuCode: all.get(id)!.getSkuCode(), styleName: 'Summer Dress', size: all.get(id)!.getSize(), color: 'Red' }), (styleId) => (styleId === style.getId() ? [skuM.getId(), skuL.getId()] : []));
        set = new SetReorderLevelUsecase(branches, skus, levels);
        setStyle = new SetReorderLevelForStyleUsecase(branches, styles, levels);
        list = new ListReorderLevelsUsecase(branches, levels);
        remove = new DeleteReorderLevelUsecase(levels);
    });

    describe('setting a minimum for one sku', () => {
        it('a manager sets it at their own branch, with an optional target', async () => {
            const result = await set.execute(body({ targetQuantity: 12 }), hamraManager());
            expect(result).toMatchObject({ branchId: hamra.getId(), skuId: skuM.getId(), minQuantity: 5, targetQuantity: 12 });
            expect((await set.execute(body({ minQuantity: 8 }), hamraManager())).minQuantity).toBe(8);      // setting again replaces it
            expect(levels.levels.size).toBe(1);
            expect(levels.audit).toEqual(['reorder_level.set', 'reorder_level.set']);
        });

        it('the admin can set it at any branch', async () => {
            expect((await set.execute(body({ branchId: tripoli.getId() }), admin())).branchId).toBe(tripoli.getId());
        });

        it('a manager cannot set it at a branch that is not theirs; an employee cannot set it at all', async () => {
            await expect(set.execute(body({ branchId: tripoli.getId() }), hamraManager())).rejects.toBeInstanceOf(ForbiddenError);
            await expect(set.execute(body(), makeAuth(UserRole.EMPLOYEE, [hamra.getId()]))).rejects.toThrow('Missing permission: adjustments.create');
            expect(levels.levels.size).toBe(0);
        });

        it('the warehouse has no minimum: it supplies the branches', async () => {
            await expect(set.execute(body({ branchId: warehouse.getId() }), admin())).rejects.toThrow('The warehouse has no minimum');
        });

        it('refuses a closed branch, an unknown branch or sku, and an inactive sku', async () => {
            await expect(set.execute(body({ branchId: closed.getId() }), admin())).rejects.toBeInstanceOf(ConflictError);
            await expect(set.execute(body({ branchId: randomUUID() }), admin())).rejects.toBeInstanceOf(NotFoundError);
            await expect(set.execute(body({ skuId: randomUUID() }), admin())).rejects.toBeInstanceOf(NotFoundError);
            await expect(set.execute(body({ skuId: retired.getId() }), admin())).rejects.toThrow('This sku is inactive');
        });

        it('every bad value is a 400', async () => {
            const bad: unknown[] = [undefined, null, 'x', [], {}, body({ branchId: 'abc' }), body({ skuId: 'abc' }), body({ minQuantity: -1 }), body({ minQuantity: 1.5 }), body({ minQuantity: '5' }),
                body({ minQuantity: undefined }), body({ targetQuantity: 3 }), body({ targetQuantity: 'x' })];
            for (const input of bad) await expect(set.execute(input, admin()), JSON.stringify(input)).rejects.toBeInstanceOf(ValidationError);
            expect(levels.levels.size).toBe(0);
        });
    });

    describe('setting a minimum per model', () => {
        const styleBody = (patch: Record<string, unknown> = {}) => ({ branchId: hamra.getId(), styleId: style.getId(), minQuantity: 4, ...patch });

        it('sets the same minimum for every ACTIVE size of the style', async () => {
            expect(await setStyle.execute(styleBody({ targetQuantity: 10 }), hamraManager())).toEqual({ styleId: style.getId(), skus: 2 });
            expect([...levels.levels.values()].map((l) => [l.size, l.minQuantity, l.targetQuantity]).sort()).toEqual([['L', 4, 10], ['M', 4, 10]]);
            expect(levels.audit).toEqual(['reorder_level.set_style']);
        });

        it('same rules: own branch only, no warehouse, valid numbers, a style that exists and has active skus', async () => {
            await expect(setStyle.execute(styleBody({ branchId: tripoli.getId() }), hamraManager())).rejects.toBeInstanceOf(ForbiddenError);
            await expect(setStyle.execute(styleBody({ branchId: warehouse.getId() }), admin())).rejects.toBeInstanceOf(ConflictError);
            await expect(setStyle.execute(styleBody({ minQuantity: -2 }), admin())).rejects.toBeInstanceOf(ValidationError);
            await expect(setStyle.execute(styleBody({ styleId: randomUUID() }), admin())).rejects.toBeInstanceOf(NotFoundError);
            const empty = makeStyle({ name: 'Empty' });
            const styles = new FakeStyleRepository();
            await styles.save(empty, 'c');
            const noSkus = new SetReorderLevelForStyleUsecase(new FakeBranchRepository([hamra]), styles, levels);
            await expect(noSkus.execute({ branchId: hamra.getId(), styleId: empty.getId(), minQuantity: 3 }, admin())).rejects.toThrow('no active skus');
        });
    });

    describe('reading and deleting', () => {
        beforeEach(async () => {
            await set.execute(body(), admin());
            await set.execute(body({ skuId: skuL.getId(), minQuantity: 2 }), admin());
            await set.execute(body({ branchId: tripoli.getId() }), admin());
        });

        it('lists the minimums of ONE branch, searchable and paged', async () => {
            expect((await list.execute({ branchId: hamra.getId() }, hamraManager())).map((l) => l.size).sort()).toEqual(['L', 'M']);
            expect(await list.execute({ branchId: hamra.getId(), limit: 1, offset: 1 }, hamraManager())).toHaveLength(1);
            expect(await list.execute({ branchId: hamra.getId(), search: 'zzz' }, hamraManager())).toEqual([]);
            await expect(list.execute({ branchId: tripoli.getId() }, hamraManager())).rejects.toBeInstanceOf(ForbiddenError);
            await expect(list.execute({}, admin())).rejects.toBeInstanceOf(ValidationError);
            await expect(list.execute({ branchId: hamra.getId(), limit: 0 }, admin())).rejects.toBeInstanceOf(ValidationError);
        });

        it('deletes a minimum at your branch; one at a branch you do not reach looks like it does not exist', async () => {
            const [mine] = await list.execute({ branchId: hamra.getId() }, admin());
            const [theirs] = await list.execute({ branchId: tripoli.getId() }, admin());
            await expect(remove.execute(theirs.id, hamraManager())).rejects.toBeInstanceOf(NotFoundError);
            await expect(remove.execute('missing', hamraManager())).rejects.toBeInstanceOf(NotFoundError);
            await expect(remove.execute(mine.id, makeAuth(UserRole.EMPLOYEE, [hamra.getId()]))).rejects.toBeInstanceOf(ForbiddenError);
            await remove.execute(mine.id, hamraManager());
            expect(await list.execute({ branchId: hamra.getId() }, admin())).toHaveLength(1);
            expect(levels.audit).toContain('reorder_level.delete');
        });
    });
});
