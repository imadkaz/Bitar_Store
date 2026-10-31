import { AuthContext } from '../../models/AuthContext';
import { Branch } from '../../models/Branch.model';
import { suggestedQuantity } from '../../models/ReorderLevel.model';
import { IAuditRepository, AuditEventView } from '../../repositories/interfaces/IAuditRepository';
import { IBranchRepository } from '../../repositories/interfaces/IBranchRepository';
import { ILocationRepository } from '../../repositories/interfaces/ILocationRepository';
import { IReorderLevelRepository } from '../../repositories/interfaces/IReorderLevelRepository';
import { IReportRepository, ReplenishmentRow, SalesSummaryRow, TopSkuRow } from '../../repositories/interfaces/IReportRepository';
import { ISkuRepository, SkuWithStyle } from '../../repositories/interfaces/ISkuRepository';
import { IStockQueryRepository, MovementView, Quantities } from '../../repositories/interfaces/IStockQueryRepository';
import { ForbiddenError } from '../../utils/exeptions/ForbiddenError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { resolvePaging, resolveSearch } from '../styles/paging';
import { parseDateRange, parseOptionalUuid, parseRequiredUuid, parseShopDay, parseSlug, resolveBranchScope } from './scope';

// ---------------------------------------------------------------------------------------------------------------
// The admin's view of EVERY place (the warehouse and all the branches): what each sku has, where, and who is below the minimum.
export interface OverviewLocation {
    branch: Branch;
    quantities: Quantities;
    minQuantity: number | null;
    targetQuantity: number | null;
    belowMinimum: boolean;
}

export interface OverviewItem {
    sku: SkuWithStyle;
    totals: Quantities;
    locations: OverviewLocation[];
}

export class GetStockOverviewUsecase {
    constructor(
        private readonly skus: ISkuRepository,
        private readonly branches: IBranchRepository,
        private readonly stock: IStockQueryRepository,
        private readonly levels: IReorderLevelRepository,
    ) {}

    async execute(input: { search?: unknown; styleId?: string; activeOnly?: boolean; limit?: unknown; offset?: unknown }, auth: AuthContext): Promise<{ locations: Branch[]; items: OverviewItem[] }> {
        if (!auth.isAdmin()) throw new ForbiddenError('Only the admin sees the stock of every location');
        const { limit, offset } = resolvePaging(input.limit, input.offset);
        const locations = (await this.branches.list()).filter((b) => b.isActive()).sort((a, b) => Number(b.isWarehouse()) - Number(a.isWarehouse()) || a.getCode().localeCompare(b.getCode()));
        const page = await this.skus.list({ styleId: input.styleId, search: resolveSearch(input.search), activeOnly: input.activeOnly ?? false, limit, offset });
        const ids = page.map((p) => p.sku.getId());
        const quantities = await this.stock.quantities(ids);
        const levels = await this.levels.findForSkus(ids);
        const zero = (): Quantities => ({ sellable: 0, nonSellable: 0, inTransit: 0 });

        const items = page.map((row): OverviewItem => {
            const skuId = row.sku.getId();
            const totals = zero();
            const perLocation = locations.map((branch): OverviewLocation => {
                const q = quantities.get(skuId)?.get(branch.getId()) ?? zero();
                const level = levels.get(`${skuId}|${branch.getId()}`) ?? null;
                totals.sellable += q.sellable;
                totals.nonSellable += q.nonSellable;
                totals.inTransit += q.inTransit;
                return { branch, quantities: q, minQuantity: level?.min ?? null, targetQuantity: level?.target ?? null, belowMinimum: level !== null && q.sellable + q.inTransit < level.min };
            });
            return { sku: row, totals, locations: perLocation };
        });
        return { locations, items };
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Every movement of one place: who moved what, when. Needs the adjustments permission and a place you reach.
export class ListStockMovementsUsecase {
    constructor(private readonly branches: IBranchRepository, private readonly stock: IStockQueryRepository) {}

    async execute(input: { branchId?: unknown; skuId?: unknown; type?: unknown; from?: unknown; to?: unknown; limit?: unknown; offset?: unknown }, auth: AuthContext): Promise<MovementView[]> {
        if (!auth.can('adjustments.create')) throw new ForbiddenError('Missing permission: adjustments.create');
        const branchId = parseRequiredUuid(input.branchId, 'branchId');
        const skuId = parseOptionalUuid(input.skuId, 'skuId');
        const movementType = parseSlug(input.type, 'type');
        const from = parseShopDay(input.from, 'from');
        const to = parseShopDay(input.to, 'to');
        if (from && to && from > to) throw new ValidationError('from cannot be after to');
        const { limit, offset } = resolvePaging(input.limit, input.offset);
        if (!auth.canAccessBranch(branchId)) throw new ForbiddenError('You cannot see the movements of this branch');
        if (!(await this.branches.findById(branchId))) throw new NotFoundError('Branch not found');
        return this.stock.movements({ branchId, skuId, movementType, from, to, limit, offset });
    }
}

// ---------------------------------------------------------------------------------------------------------------
// "Branch X is below its minimum for Y: send N". Computed when asked, from the balances: no background job.
export interface ReplenishmentSuggestion {
    branch: Branch;
    row: ReplenishmentRow;
    suggested: number;          // to bring the branch back up to its target (or minimum)
    warehouseSellable: number;  // what the warehouse has of this sku
    fillable: number;           // what it can send now: the smaller of the two
}

export class GetReplenishmentSuggestionsUsecase {
    constructor(
        private readonly branches: IBranchRepository,
        private readonly locations: ILocationRepository,
        private readonly reports: IReportRepository,
    ) {}

    async execute(input: { branchId?: unknown }, auth: AuthContext): Promise<{ warehouse: Branch | null; suggestions: ReplenishmentSuggestion[] }> {
        if (!auth.can('adjustments.create')) throw new ForbiddenError('Missing permission: adjustments.create');
        const scope = await resolveBranchScope(auth, input.branchId, this.branches, { onlyBranches: true });
        const byId = new Map(scope.map((b) => [b.getId(), b]));
        const rows = await this.reports.replenishment(scope.map((b) => b.getId()));
        const warehouse = await this.locations.findWarehouse();
        const stockAtWarehouse = warehouse && rows.length > 0 ? await this.reports.sellableAt(warehouse.getId(), [...new Set(rows.map((r) => r.skuId))]) : new Map<string, number>();

        const suggestions = rows
            .map((row): ReplenishmentSuggestion => {
                const suggested = suggestedQuantity(row.sellable, row.inTransit, row.minQuantity, row.targetQuantity);
                const warehouseSellable = stockAtWarehouse.get(row.skuId) ?? 0;
                return { branch: byId.get(row.branchId)!, row, suggested, warehouseSellable, fillable: Math.min(suggested, warehouseSellable) };
            })
            .filter((s) => s.suggested > 0)
            .sort((a, b) => b.suggested - a.suggested || a.branch.getCode().localeCompare(b.branch.getCode()) || a.row.skuCode.localeCompare(b.row.skuCode));
        return { warehouse, suggestions };
    }
}

// ---------------------------------------------------------------------------------------------------------------
export interface SalesSummary {
    from: string;
    to: string;
    branches: Branch[];
    rows: SalesSummaryRow[];
    totals: Omit<SalesSummaryRow, 'branchId' | 'day'>;
}

export class GetSalesSummaryUsecase {
    constructor(private readonly branches: IBranchRepository, private readonly reports: IReportRepository, private readonly now: () => Date = () => new Date()) {}

    async execute(input: { branchId?: unknown; from?: unknown; to?: unknown }, auth: AuthContext): Promise<SalesSummary> {
        if (!auth.can('reports.financial')) throw new ForbiddenError('Missing permission: reports.financial');
        const { from, to } = parseDateRange(input.from, input.to, this.now());
        const scope = await resolveBranchScope(auth, input.branchId, this.branches, { onlyBranches: true });
        const rows = await this.reports.salesSummary({ branchIds: scope.map((b) => b.getId()), from, to });
        const totals = rows.reduce(
            (t, r) => ({
                salesCount: t.salesCount + r.salesCount, items: t.items + r.items, revenueCents: t.revenueCents + r.revenueCents, discountCents: t.discountCents + r.discountCents,
                cashCents: t.cashCents + r.cashCents, whishCents: t.whishCents + r.whishCents, inStoreCents: t.inStoreCents + r.inStoreCents, socialMediaCents: t.socialMediaCents + r.socialMediaCents,
            }),
            { salesCount: 0, items: 0, revenueCents: 0, discountCents: 0, cashCents: 0, whishCents: 0, inStoreCents: 0, socialMediaCents: 0 },
        );
        return { from, to, branches: scope, rows, totals };
    }
}

export class GetTopSkusUsecase {
    constructor(private readonly branches: IBranchRepository, private readonly reports: IReportRepository, private readonly now: () => Date = () => new Date()) {}

    async execute(input: { branchId?: unknown; from?: unknown; to?: unknown; limit?: unknown }, auth: AuthContext): Promise<{ from: string; to: string; rows: TopSkuRow[] }> {
        if (!auth.can('reports.financial')) throw new ForbiddenError('Missing permission: reports.financial');
        const { from, to } = parseDateRange(input.from, input.to, this.now());
        let limit = 10;
        if (input.limit !== undefined) {
            if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new ValidationError('limit must be a whole number between 1 and 100');
            limit = input.limit;
        }
        const scope = await resolveBranchScope(auth, input.branchId, this.branches, { onlyBranches: true });
        return { from, to, rows: await this.reports.topSkus({ branchIds: scope.map((b) => b.getId()), from, to }, limit) };
    }
}

// ---------------------------------------------------------------------------------------------------------------
export class ListAuditEventsUsecase {
    constructor(private readonly audit: IAuditRepository) {}

    async execute(input: { entityType?: unknown; entityId?: unknown; actorId?: unknown; branchId?: unknown; from?: unknown; to?: unknown; limit?: unknown; offset?: unknown }, auth: AuthContext): Promise<AuditEventView[]> {
        if (!auth.isAdmin()) throw new ForbiddenError('Only the admin reads the audit log');
        const entityType = parseSlug(input.entityType, 'entityType');
        const entityId = parseOptionalUuid(input.entityId, 'entityId');
        const actorId = parseOptionalUuid(input.actorId, 'actorId');
        const branchId = parseOptionalUuid(input.branchId, 'branchId');
        const from = parseShopDay(input.from, 'from');
        const to = parseShopDay(input.to, 'to');
        if (from && to && from > to) throw new ValidationError('from cannot be after to');
        const { limit, offset } = resolvePaging(input.limit, input.offset);
        return this.audit.list({ entityType, entityId, actorId, branchId, from, to, limit, offset });
    }
}

