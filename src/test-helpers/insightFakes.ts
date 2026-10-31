import { Branch } from '../models/Branch.model';
import { IAuditRepository, AuditEventView, AuditFilter } from '../repositories/interfaces/IAuditRepository';
import { ILocationRepository } from '../repositories/interfaces/ILocationRepository';
import { IReorderLevelRepository, ReorderLevelListFilter, ReorderLevelView } from '../repositories/interfaces/IReorderLevelRepository';
import { IReportRepository, ReplenishmentRow, ReportScope, SalesSummaryRow, TopSkuRow } from '../repositories/interfaces/IReportRepository';
import { IStockQueryRepository, MovementFilter, MovementView, Quantities } from '../repositories/interfaces/IStockQueryRepository';
import { FakeBranchRepository } from './fakes';

// Everything here is an in-memory stand-in: the tests check the RULES (who may see what, which values are refused),
// while the real database tests check the SQL numbers.

export class FakeLocationRepository implements ILocationRepository {
    audited: { branchId: string; actorId: string; details: Record<string, unknown> }[] = [];
    activeBranches = new Set<string>();     // branches that "already have sales or minimums"

    constructor(private readonly branches: FakeBranchRepository) {}

    async findWarehouse() {
        return (await this.branches.list()).find((b) => b.isWarehouse()) ?? null;
    }

    async hasActivity(branchId: string) {
        return this.activeBranches.has(branchId);
    }

    async updateAudited(branch: Branch, actorId: string, details: Record<string, unknown>) {
        this.audited.push({ branchId: branch.getId(), actorId, details });
        return this.branches.update(branch);
    }
}

export class FakeReorderLevelRepository implements IReorderLevelRepository {
    levels = new Map<string, ReorderLevelView & { actorId: string }>();
    audit: string[] = [];

    constructor(
        private readonly describe: (skuId: string) => { skuCode: string; styleName: string; size: string; color: string },
        private readonly activeSkusOfStyle: (styleId: string) => string[] = () => [],
    ) {}

    private put(branchId: string, skuId: string, min: number, target: number | null, actorId: string): ReorderLevelView {
        const key = `${skuId}|${branchId}`;
        const existing = this.levels.get(key);
        const view = { id: existing?.id ?? `level-${this.levels.size + 1}`, branchId, skuId, ...this.describe(skuId), minQuantity: min, targetQuantity: target, updatedAt: new Date(), actorId };
        this.levels.set(key, view);
        return view;
    }

    async list(filter: ReorderLevelListFilter) {
        const all = [...this.levels.values()].filter((l) => l.branchId === filter.branchId).filter((l) => !filter.search || l.skuCode.toLowerCase().includes(filter.search.toLowerCase()));
        return all.sort((a, b) => a.skuCode.localeCompare(b.skuCode)).slice(filter.offset, filter.offset + filter.limit);
    }

    async findById(id: string) {
        return [...this.levels.values()].find((l) => l.id === id) ?? null;
    }

    async findForSkus(skuIds: string[]) {
        return new Map([...this.levels.values()].filter((l) => skuIds.includes(l.skuId)).map((l) => [`${l.skuId}|${l.branchId}`, { min: l.minQuantity, target: l.targetQuantity }]));
    }

    async upsert(branchId: string, skuId: string, min: number, target: number | null, actorId: string) {
        this.audit.push('reorder_level.set');
        return this.put(branchId, skuId, min, target, actorId);
    }

    async upsertForStyle(branchId: string, styleId: string, min: number, target: number | null, actorId: string) {
        const ids = this.activeSkusOfStyle(styleId);
        ids.forEach((skuId) => this.put(branchId, skuId, min, target, actorId));
        if (ids.length > 0) this.audit.push('reorder_level.set_style');
        return ids.length;
    }

    async delete(id: string) {
        const found = await this.findById(id);
        if (found) {
            this.levels.delete(`${found.skuId}|${found.branchId}`);
            this.audit.push('reorder_level.delete');
        }
    }
}

export class FakeStockQueryRepository implements IStockQueryRepository {
    balances = new Map<string, Map<string, Quantities>>();     // skuId -> branchId -> quantities
    movementRows: MovementView[] = [];
    lastMovementFilter: MovementFilter | null = null;

    setQuantities(skuId: string, branchId: string, q: Partial<Quantities>) {
        const perBranch = this.balances.get(skuId) ?? new Map<string, Quantities>();
        perBranch.set(branchId, { sellable: 0, nonSellable: 0, inTransit: 0, ...q });
        this.balances.set(skuId, perBranch);
    }

    async quantities(skuIds: string[]) {
        return new Map([...this.balances].filter(([skuId]) => skuIds.includes(skuId)));
    }

    async movements(filter: MovementFilter) {
        this.lastMovementFilter = filter;
        return this.movementRows;
    }
}

export class FakeReportRepository implements IReportRepository {
    summaryRows: SalesSummaryRow[] = [];
    topRows: TopSkuRow[] = [];
    replenishmentRows: ReplenishmentRow[] = [];
    warehouseStock = new Map<string, number>();
    lastScope: ReportScope | null = null;
    lastTopLimit: number | null = null;
    lastReplenishmentBranches: string[] | null = null;

    async salesSummary(scope: ReportScope) {
        this.lastScope = scope;
        return this.summaryRows.filter((r) => scope.branchIds.includes(r.branchId));
    }

    async topSkus(scope: ReportScope, limit: number) {
        this.lastScope = scope;
        this.lastTopLimit = limit;
        return this.topRows;
    }

    async replenishment(branchIds: string[]) {
        this.lastReplenishmentBranches = branchIds;
        return this.replenishmentRows.filter((r) => branchIds.includes(r.branchId));
    }

    async sellableAt(_branchId: string, skuIds: string[]) {
        return new Map(skuIds.filter((id) => this.warehouseStock.has(id)).map((id) => [id, this.warehouseStock.get(id)!]));
    }
}

export class FakeAuditRepository implements IAuditRepository {
    rows: AuditEventView[] = [];
    lastFilter: AuditFilter | null = null;

    async list(filter: AuditFilter) {
        this.lastFilter = filter;
        return this.rows;
    }
}
