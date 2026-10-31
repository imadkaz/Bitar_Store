import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Branch } from '../../../models/Branch.model';
import { Sku } from '../../../models/Sku.model';
import { UserRole } from '../../../models/User.model';
import { FakeBranchRepository } from '../../../test-helpers/fakes';
import { FakeBarcodeRepository, FakeSkuRepository, FakeStyleRepository, makeSku, makeStyle } from '../../../test-helpers/catalogFakes';
import { FakeAuditRepository, FakeLocationRepository, FakeReorderLevelRepository, FakeReportRepository, FakeStockQueryRepository } from '../../../test-helpers/insightFakes';
import { makeAuth } from '../../../test-helpers/salesFakes';
import { ForbiddenError } from '../../../utils/exeptions/ForbiddenError';
import { NotFoundError } from '../../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../../utils/exeptions/ValidationError';
import {
    GetReplenishmentSuggestionsUsecase, GetSalesSummaryUsecase, GetStockOverviewUsecase, GetTopSkusUsecase, ListAuditEventsUsecase, ListStockMovementsUsecase,
} from '../InsightUsecases';

describe('the warehouse view', () => {
    let warehouse: Branch;
    let hamra: Branch;
    let tripoli: Branch;
    let closed: Branch;
    let dressM: Sku;
    let dressL: Sku;
    let branches: FakeBranchRepository;
    let locations: FakeLocationRepository;
    let stock: FakeStockQueryRepository;
    let reports: FakeReportRepository;
    let levels: FakeReorderLevelRepository;
    let skus: FakeSkuRepository;
    const today = () => new Date('2026-10-29T10:00:00Z');
    const admin = () => makeAuth(UserRole.ADMIN);
    const hamraManager = () => makeAuth(UserRole.MANAGER, [hamra.getId()]);
    const employee = () => makeAuth(UserRole.EMPLOYEE, [hamra.getId()]);

    beforeEach(async () => {
        warehouse = Branch.create({ id: randomUUID(), code: 'WAREHOUSE', name: 'Main Warehouse', kind: 'warehouse' });
        hamra = Branch.create({ id: randomUUID(), code: 'HAMRA', name: 'Hamra' });
        tripoli = Branch.create({ id: randomUUID(), code: 'TRIPOLI', name: 'Tripoli' });
        closed = Branch.create({ id: randomUUID(), code: 'OLD', name: 'Old', isActive: false });
        branches = new FakeBranchRepository([hamra, warehouse, tripoli, closed]);
        locations = new FakeLocationRepository(branches);
        const styles = new FakeStyleRepository();
        skus = new FakeSkuRepository(styles, new FakeBarcodeRepository());
        const style = makeStyle({ name: 'Summer Dress' });
        await styles.save(style, 'c');
        dressM = makeSku(style.getId(), { size: 'M' });
        dressL = makeSku(style.getId(), { size: 'L' });
        await skus.save(dressM, 'c');
        await skus.save(dressL, 'c');
        stock = new FakeStockQueryRepository();
        reports = new FakeReportRepository();
        levels = new FakeReorderLevelRepository((id) => ({ skuCode: id.slice(0, 6), styleName: 'Summer Dress', size: 'M', color: 'Red' }));
    });

    describe('overview of every place (admin only)', () => {
        let overview: GetStockOverviewUsecase;
        beforeEach(() => {
            overview = new GetStockOverviewUsecase(skus, branches, stock, levels);
            stock.setQuantities(dressM.getId(), warehouse.getId(), { sellable: 50 });
            stock.setQuantities(dressM.getId(), hamra.getId(), { sellable: 3, nonSellable: 1, inTransit: 2 });
            stock.setQuantities(dressM.getId(), tripoli.getId(), { sellable: 8 });
        });

        it('only the admin sees it: a manager sees their own branch through /stock, never every place', async () => {
            await expect(overview.execute({}, hamraManager())).rejects.toThrow('Only the admin');
            await expect(overview.execute({}, employee())).rejects.toBeInstanceOf(ForbiddenError);
        });

        it('lists the warehouse first, then the active branches; a closed branch is left out', async () => {
            const { locations: columns } = await overview.execute({}, admin());
            expect(columns.map((b) => [b.getCode(), b.getKind()])).toEqual([['WAREHOUSE', 'warehouse'], ['HAMRA', 'branch'], ['TRIPOLI', 'branch']]);
        });

        it('per sku: the quantity at every place, the total, and 0 where there is nothing', async () => {
            const { items } = await overview.execute({}, admin());
            const m = items.find((i) => i.sku.sku.getSize() === 'M')!;
            expect(m.totals).toEqual({ sellable: 61, nonSellable: 1, inTransit: 2 });
            expect(m.locations.map((l) => [l.quantities.sellable, l.quantities.nonSellable, l.quantities.inTransit])).toEqual([[50, 0, 0], [3, 1, 2], [8, 0, 0]]);
            const l = items.find((i) => i.sku.sku.getSize() === 'L')!;
            expect(l.totals).toEqual({ sellable: 0, nonSellable: 0, inTransit: 0 });
            expect(l.locations).toHaveLength(3);
        });

        it('flags a branch below its minimum, counting what is already on the road', async () => {
            await levels.upsert(hamra.getId(), dressM.getId(), 6, null, 'x');       // 3 here + 2 coming = 5, below 6
            await levels.upsert(tripoli.getId(), dressM.getId(), 8, null, 'x');     // exactly 8: not below
            const { items } = await overview.execute({}, admin());
            const m = items.find((i) => i.sku.sku.getSize() === 'M')!;
            const byCode = new Map(m.locations.map((x) => [x.branch.getCode(), x]));
            expect(byCode.get('HAMRA')).toMatchObject({ minQuantity: 6, belowMinimum: true });
            expect(byCode.get('TRIPOLI')).toMatchObject({ minQuantity: 8, belowMinimum: false });
            expect(byCode.get('WAREHOUSE')).toMatchObject({ minQuantity: null, belowMinimum: false });
        });

        it('pages and searches the skus', async () => {
            expect((await overview.execute({ limit: 1 }, admin())).items).toHaveLength(1);
            await expect(overview.execute({ limit: 0 }, admin())).rejects.toBeInstanceOf(ValidationError);
        });
    });

    describe('movements of one place', () => {
        let movements: ListStockMovementsUsecase;
        beforeEach(() => { movements = new ListStockMovementsUsecase(branches, stock); });

        it('needs the permission and a place you reach; the admin reaches the warehouse too', async () => {
            await expect(movements.execute({ branchId: hamra.getId() }, employee())).rejects.toThrow('Missing permission');
            await expect(movements.execute({ branchId: tripoli.getId() }, hamraManager())).rejects.toBeInstanceOf(ForbiddenError);
            await expect(movements.execute({ branchId: randomUUID() }, admin())).rejects.toBeInstanceOf(NotFoundError);
            await movements.execute({ branchId: warehouse.getId() }, admin());
            await movements.execute({ branchId: hamra.getId() }, hamraManager());
            expect(stock.lastMovementFilter).toMatchObject({ branchId: hamra.getId(), limit: 50, offset: 0 });
        });

        it('passes the filters on, and refuses bad ones', async () => {
            const sku = randomUUID();
            await movements.execute({ branchId: hamra.getId(), skuId: sku, type: 'sale', from: '2026-10-01', to: '2026-10-29', limit: 10, offset: 5 }, admin());
            expect(stock.lastMovementFilter).toEqual({ branchId: hamra.getId(), skuId: sku, movementType: 'sale', from: '2026-10-01', to: '2026-10-29', limit: 10, offset: 5 });
            const bad = [{}, { branchId: 'abc' }, { branchId: hamra.getId(), skuId: 'abc' }, { branchId: hamra.getId(), type: 'Sale!' }, { branchId: hamra.getId(), from: '2026-02-30' },
                { branchId: hamra.getId(), from: '2026-10-29', to: '2026-10-01' }, { branchId: hamra.getId(), limit: 500 }];
            for (const input of bad) await expect(movements.execute(input, admin()), JSON.stringify(input)).rejects.toBeInstanceOf(ValidationError);
        });
    });

    describe('what to send', () => {
        let suggestions: GetReplenishmentSuggestionsUsecase;
        const row = (branch: Branch, sku: Sku, sellable: number, inTransit: number, min: number, target: number | null) =>
            ({ branchId: branch.getId(), skuId: sku.getId(), skuCode: sku.getSkuCode(), styleName: 'Summer Dress', size: sku.getSize(), color: 'Red', sellable, inTransit, minQuantity: min, targetQuantity: target });

        beforeEach(() => {
            suggestions = new GetReplenishmentSuggestionsUsecase(branches, locations, reports);
            reports.replenishmentRows = [row(hamra, dressM, 2, 0, 10, 20), row(hamra, dressL, 4, 3, 10, null), row(tripoli, dressM, 0, 0, 6, null), row(tripoli, dressL, 9, 0, 6, null)];
            reports.warehouseStock = new Map([[dressM.getId(), 15], [dressL.getId(), 1]]);
        });

        it('suggests what brings each branch back to its target, and what the warehouse can really send', async () => {
            const { warehouse: wh, suggestions: list } = await suggestions.execute({}, admin());
            expect(wh?.getCode()).toBe('WAREHOUSE');
            // hamra M: 20 - 2 = 18, the warehouse has 15 -> sends 15 | hamra L: 10 - (4 + 3) = 3, the warehouse has 1 -> sends 1 | tripoli M: 6, sends 6 | tripoli L: 9 is fine
            expect(list.map((s) => [s.branch.getCode(), s.row.size, s.suggested, s.warehouseSellable, s.fillable])).toEqual([
                ['HAMRA', 'M', 18, 15, 15], ['TRIPOLI', 'M', 6, 15, 6], ['HAMRA', 'L', 3, 1, 1],
            ].map(([b, s, ...rest]) => [b, s === 'M' ? dressM.getSize() : dressL.getSize(), ...rest]));
        });

        it('a branch that has enough, counting what is on the road, is not in the list', async () => {
            reports.replenishmentRows = [row(hamra, dressM, 2, 3, 5, null)];       // 2 + 3 = 5 = the minimum
            expect((await suggestions.execute({}, admin())).suggestions).toEqual([]);
        });

        it('with no warehouse yet, it still suggests, and nothing is fillable', async () => {
            const noWarehouse = new FakeBranchRepository([hamra, tripoli]);
            const uc = new GetReplenishmentSuggestionsUsecase(noWarehouse, new FakeLocationRepository(noWarehouse), reports);
            const result = await uc.execute({}, admin());
            expect(result.warehouse).toBeNull();
            expect(result.suggestions.every((s) => s.fillable === 0 && s.suggested > 0)).toBe(true);
        });

        it('a manager sees only the branches granted to them; the admin sees them all; the warehouse is never a branch to fill', async () => {
            const mine = await suggestions.execute({}, hamraManager());
            expect(new Set(mine.suggestions.map((s) => s.branch.getCode()))).toEqual(new Set(['HAMRA']));
            expect(reports.lastReplenishmentBranches).toEqual([hamra.getId()]);
            await suggestions.execute({}, admin());
            expect(new Set(reports.lastReplenishmentBranches)).toEqual(new Set([hamra.getId(), tripoli.getId()]));       // not the warehouse, not the closed branch
        });

        it('naming a branch: must be reachable and exist; the warehouse gives an empty answer', async () => {
            await expect(suggestions.execute({ branchId: tripoli.getId() }, hamraManager())).rejects.toBeInstanceOf(ForbiddenError);
            await expect(suggestions.execute({ branchId: randomUUID() }, admin())).rejects.toBeInstanceOf(NotFoundError);
            await expect(suggestions.execute({ branchId: 'abc' }, admin())).rejects.toBeInstanceOf(ValidationError);
            expect((await suggestions.execute({ branchId: warehouse.getId() }, admin())).suggestions).toEqual([]);
            await expect(suggestions.execute({}, employee())).rejects.toThrow('Missing permission');
        });
    });

    describe('sales reports', () => {
        let summary: GetSalesSummaryUsecase;
        let top: GetTopSkusUsecase;
        const day = (branch: Branch, date: string, revenueCents: number) => ({
            branchId: branch.getId(), day: date, salesCount: 2, items: 3, revenueCents, discountCents: 100, cashCents: revenueCents - 500, whishCents: 500, inStoreCents: revenueCents, socialMediaCents: 0,
        });

        beforeEach(() => {
            summary = new GetSalesSummaryUsecase(branches, reports, today);
            top = new GetTopSkusUsecase(branches, reports, today);
            reports.summaryRows = [day(hamra, '2026-10-29', 4500), day(tripoli, '2026-10-29', 3000), day(hamra, '2026-10-28', 1000)];
        });

        it('needs the financial permission', async () => {
            await expect(summary.execute({}, employee())).rejects.toThrow('Missing permission: reports.financial');
            await expect(top.execute({}, employee())).rejects.toThrow('Missing permission: reports.financial');
        });

        it('today by default, and the totals add up the rows', async () => {
            const result = await summary.execute({}, admin());
            expect([result.from, result.to]).toEqual(['2026-10-29', '2026-10-29']);
            expect(reports.lastScope).toMatchObject({ from: '2026-10-29', to: '2026-10-29' });
            expect(result.totals).toMatchObject({ salesCount: 6, items: 9, revenueCents: 8500, whishCents: 1500, cashCents: 7000 });
        });

        it('a manager reads their own branches only, the admin every branch (never the warehouse)', async () => {
            await summary.execute({}, hamraManager());
            expect(reports.lastScope?.branchIds).toEqual([hamra.getId()]);
            await summary.execute({}, admin());
            expect(new Set(reports.lastScope?.branchIds)).toEqual(new Set([hamra.getId(), tripoli.getId()]));
            await expect(summary.execute({ branchId: tripoli.getId() }, hamraManager())).rejects.toBeInstanceOf(ForbiddenError);
        });

        it('dates: a real range, from not after to, at most 366 days', async () => {
            await summary.execute({ from: '2026-10-01', to: '2026-10-29' }, admin());
            expect(reports.lastScope).toMatchObject({ from: '2026-10-01', to: '2026-10-29' });
            await summary.execute({ from: '2026-10-20' }, admin());
            expect(reports.lastScope).toMatchObject({ from: '2026-10-20', to: '2026-10-20' });
            await summary.execute({ from: '2025-10-29', to: '2026-10-29' }, admin());          // 366 days: allowed
            const bad = [{ from: '2026-10-29', to: '2026-10-01' }, { from: '2025-10-28', to: '2026-10-29' }, { from: '2026-02-30' }, { to: 'today' }, { from: 20261029 }];
            for (const input of bad) await expect(summary.execute(input, admin()), JSON.stringify(input)).rejects.toBeInstanceOf(ValidationError);
        });

        it('top skus: limit 1 to 100 (default 10), same scope rules', async () => {
            await top.execute({}, hamraManager());
            expect(reports.lastTopLimit).toBe(10);
            expect(reports.lastScope?.branchIds).toEqual([hamra.getId()]);
            await top.execute({ limit: 100 }, admin());
            expect(reports.lastTopLimit).toBe(100);
            for (const limit of [0, 101, 1.5, '5']) await expect(top.execute({ limit }, admin()), String(limit)).rejects.toBeInstanceOf(ValidationError);
        });
    });

    describe('audit log (admin only)', () => {
        it('only the admin reads it; the filters are checked and passed on', async () => {
            const audit = new FakeAuditRepository();
            const list = new ListAuditEventsUsecase(audit);
            await expect(list.execute({}, hamraManager())).rejects.toThrow('Only the admin');
            const actor = randomUUID();
            await list.execute({ entityType: 'reorder_level', actorId: actor, from: '2026-10-01', to: '2026-10-29', limit: 20 }, admin());
            expect(audit.lastFilter).toMatchObject({ entityType: 'reorder_level', actorId: actor, from: '2026-10-01', to: '2026-10-29', limit: 20, offset: 0 });
            const bad = [{ entityType: 'Bad Type!' }, { entityId: 'abc' }, { actorId: 'abc' }, { branchId: 'abc' }, { from: 'x' }, { from: '2026-10-29', to: '2026-10-01' }, { limit: 0 }];
            for (const input of bad) await expect(list.execute(input, admin()), JSON.stringify(input)).rejects.toBeInstanceOf(ValidationError);
        });
    });
});
