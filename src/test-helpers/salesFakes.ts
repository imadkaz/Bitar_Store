import { randomUUID } from 'node:crypto';
import { AuthContext } from '../models/AuthContext';
import { resolvePermissions } from '../models/Permission';
import { Sale } from '../models/Sale.model';
import { UserRole } from '../models/User.model';
import { ISaleRepository, SaleListFilter, SaleView } from '../repositories/interfaces/ISaleRepository';
import { IdempotencyClaim, ISalesUnitOfWork, SaleTransaction, SkuForSale } from '../repositories/interfaces/ISalesUnitOfWork';
import { IStockAlertRepository, StockAlertInput } from '../repositories/interfaces/IStockAlertRepository';
import { IStockRepository, OpeningStockCommand, OpeningStockResult, StockLevel } from '../repositories/interfaces/IStockRepository';
import { ConflictError } from '../utils/exeptions/ConflictError';
import { makeUser } from './fakes';

// The pretend database of a shop, in memory. A "transaction" here takes a snapshot first and puts it back if anything
// throws, so tests can prove that a failed sale leaves NOTHING behind (no sale, no payment, no stock change, no key).

export interface WorldSku extends SkuForSale {
    size: string;
    color: string;
}

interface StoredKey { id: string; hash: string; resourceId?: string }
interface StoredSale { sale: Sale; keyId: string; actorId: string; soldAt: Date }
export interface LedgerRow { skuId: string; branchId: string; type: 'sale' | 'opening'; delta: number; balanceAfter: number; saleId?: string; actorId: string; keyId: string }

export class FakeSalesWorld {
    skus = new Map<string, WorldSku>();
    stock = new Map<string, number>();                 // `${branchId}|${skuId}` -> sellable quantity
    sales = new Map<string, StoredSale>();
    keys = new Map<string, StoredKey>();                // `${userId}|${operation}|${key}`
    ledger: LedgerRow[] = [];
    whishReferences = new Set<string>();
    alerts: StockAlertInput[] = [];                     // not part of the snapshot: alerts survive a rollback, like the real ones
    names = new Map<string, string>([['seller', 'Sara Seller']]);

    addSku(overrides: Partial<WorldSku> = {}): WorldSku {
        const sku: WorldSku = {
            skuId: randomUUID(), skuCode: `SK-${randomUUID().slice(0, 6).toUpperCase()}`, styleName: 'Summer Dress', priceCents: 4500, currency: 'USD',
            skuActive: true, styleActive: true, size: 'M', color: 'Black', ...overrides,
        };
        this.skus.set(sku.skuId, sku);
        return sku;
    }

    setStock(branchId: string, skuId: string, quantity: number) {
        this.stock.set(`${branchId}|${skuId}`, quantity);
    }

    quantity(branchId: string, skuId: string): number {
        return this.stock.get(`${branchId}|${skuId}`) ?? 0;
    }

    snapshot() {
        return { stock: new Map(this.stock), sales: new Map(this.sales), keys: new Map([...this.keys].map(([k, v]) => [k, { ...v }])), ledger: [...this.ledger], whish: new Set(this.whishReferences) };
    }

    restore(s: ReturnType<FakeSalesWorld['snapshot']>) {
        this.stock = s.stock; this.sales = s.sales; this.keys = s.keys; this.ledger = s.ledger; this.whishReferences = s.whish;
    }
}

class FakeSaleTransaction implements SaleTransaction {
    constructor(private readonly w: FakeSalesWorld) {}

    async claimIdempotencyKey(userId: string, operation: string, key: string, hash: string): Promise<IdempotencyClaim> {
        const id = `${userId}|${operation}|${key}`;
        const existing = this.w.keys.get(id);
        if (!existing) {
            const created = { id: randomUUID(), hash };
            this.w.keys.set(id, created);
            return { kind: 'claimed', keyId: created.id };
        }
        if (existing.hash !== hash) return { kind: 'different_request' };
        return existing.resourceId ? { kind: 'replay', resourceId: existing.resourceId } : { kind: 'in_progress' };
    }

    async findSkusForSale(skuIds: string[]) {
        return skuIds.map((id) => this.w.skus.get(id)).filter((s): s is WorldSku => !!s);
    }

    async lockSellableStock(branchId: string, skuIds: string[]) {
        return new Map(skuIds.map((id) => [id, this.w.quantity(branchId, id)]));
    }

    async insertSale(sale: Sale, keyId: string, actorId: string) {
        for (const payment of sale.payments) {
            if (payment.whishReference) {
                const ref = payment.whishReference.toLowerCase();
                if (this.w.whishReferences.has(ref)) throw new ConflictError('This Whish reference was already used for another payment');
                this.w.whishReferences.add(ref);
            }
        }
        this.w.sales.set(sale.id, { sale, keyId, actorId, soldAt: new Date() });
    }

    async deductStock(branchId: string, saleId: string, items: { skuId: string; quantity: number }[], actorId: string, keyId: string) {
        for (const item of items) {
            const after = this.w.quantity(branchId, item.skuId) - item.quantity;
            if (after < 0) throw new Error('the database CHECK (quantity >= 0) would refuse this');
            this.w.setStock(branchId, item.skuId, after);
            this.w.ledger.push({ skuId: item.skuId, branchId, type: 'sale', delta: -item.quantity, balanceAfter: after, saleId, actorId, keyId });
        }
    }

    async completeIdempotencyKey(keyId: string, _type: string, resourceId: string) {
        for (const stored of this.w.keys.values()) if (stored.id === keyId) stored.resourceId = resourceId;
    }
}

export class FakeSalesUnitOfWork implements ISalesUnitOfWork {
    constructor(private readonly world: FakeSalesWorld) {}

    async run<T>(work: (tx: SaleTransaction) => Promise<T>): Promise<T> {
        const snapshot = this.world.snapshot();
        try {
            return await work(new FakeSaleTransaction(this.world));
        } catch (error) {
            this.world.restore(snapshot);
            throw error;
        }
    }
}

export class FakeSaleRepository implements ISaleRepository {
    constructor(private readonly world: FakeSalesWorld) {}

    private view(stored: StoredSale, ref: number): SaleView {
        const { sale } = stored;
        return {
            id: sale.id, reference: `S-${String(ref).padStart(8, '0')}`, branchId: sale.branchId, soldBy: sale.soldBy, soldByName: this.world.names.get(sale.soldBy) ?? null,
            status: 'completed', channel: sale.channel, socialPlatform: sale.socialPlatform, currency: sale.currency,
            subtotalCents: sale.subtotalCents, discountCents: sale.discountCents, totalCents: sale.totalCents, soldAt: stored.soldAt, businessDate: sale.businessDate, note: sale.note,
            lines: sale.lines.map((l) => {
                const sku = this.world.skus.get(l.skuId)!;
                return { lineNo: l.lineNo, skuId: l.skuId, skuCode: sku.skuCode, styleName: sku.styleName, size: sku.size, color: sku.color, quantity: l.quantity, unitPriceCents: l.unitPriceStandardCents, reduction: l.reduction, lineTotalCents: l.lineTotalCents };
            }),
            payments: sale.payments.map((p) => ({ method: p.method, amountCents: p.amountCents, tenderedCents: p.tenderedCents, whishReference: p.whishReference, receivedBy: p.receivedBy })),
        };
    }

    async findById(id: string) {
        const all = [...this.world.sales.values()];
        const index = all.findIndex((s) => s.sale.id === id);
        return index < 0 ? null : this.view(all[index], index + 1);
    }

    async list(filter: SaleListFilter) {
        return [...this.world.sales.values()]
            .map((s, i) => this.view(s, i + 1))
            .filter((v) => v.branchId === filter.branchId && v.businessDate === filter.businessDate)
            .reverse()
            .slice(filter.offset, filter.offset + filter.limit);
    }
}

export class FakeStockAlertRepository implements IStockAlertRepository {
    constructor(private readonly world: FakeSalesWorld) {}

    async recordInsufficient(alerts: StockAlertInput[]) {
        for (const alert of alerts) {
            const duplicate = this.world.alerts.some((a) => a.actorId === alert.actorId && a.operation === alert.operation && a.idempotencyKey === alert.idempotencyKey && a.skuId === alert.skuId && a.branchId === alert.branchId);
            if (!duplicate) this.world.alerts.push(alert);
        }
    }
}

export class FakeStockRepository implements IStockRepository {
    constructor(private readonly world: FakeSalesWorld) {}

    async getLevels(branchId: string, skuIds: string[]) {
        return new Map<string, StockLevel>(skuIds.map((skuId) => [skuId, { skuId, sellable: this.world.quantity(branchId, skuId), nonSellable: 0, inTransit: 0 }]));
    }

    async recordOpening(command: OpeningStockCommand): Promise<OpeningStockResult> {
        const id = `${command.actorId}|stock.opening|${command.idempotencyKey}`;
        const existing = this.world.keys.get(id);
        if (existing) {
            if (existing.hash !== command.requestHash) throw new ConflictError('This Idempotency-Key was already used for a different request');
            return { batchId: existing.resourceId!, replayed: true };
        }
        const touched = (skuId: string) => this.world.ledger.some((m) => m.skuId === skuId && m.branchId === command.branchId);
        if (command.lines.some((l) => touched(l.skuId))) throw new ConflictError('Opening stock can only be set for a sku that has no movement yet at this branch');
        const batchId = randomUUID();
        const keyId = randomUUID();
        for (const line of command.lines) {
            this.world.setStock(command.branchId, line.skuId, line.quantity);
            this.world.ledger.push({ skuId: line.skuId, branchId: command.branchId, type: 'opening', delta: line.quantity, balanceAfter: line.quantity, actorId: command.actorId, keyId });
        }
        this.world.keys.set(id, { id: keyId, hash: command.requestHash, resourceId: batchId });
        return { batchId, replayed: false };
    }
}

export function makeAuth(role: UserRole, branchIds: string[] = [], overrides: { permission: never; effect: 'allow' | 'deny' }[] = []): AuthContext {
    const user = makeUser({ role });
    return new AuthContext(user, resolvePermissions(role, overrides), new Set(branchIds));
}
