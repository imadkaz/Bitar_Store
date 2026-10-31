import { Branch as BranchModel} from '../models/Branch.model';
import { User } from '../models/User.model';
import { Barcode } from '../models/Barcode.model';
import { PriceChange, Sku } from '../models/Sku.model';
import { Style } from '../models/Style.model';
import { formatCents } from '../models/Money';
import { SkuWithStyle } from '../repositories/interfaces/ISkuRepository';
import { SkuDetail } from '../usecases/skus/GetSkuUsecase';
import { SaleView } from '../repositories/interfaces/ISaleRepository';
import { StockItem } from '../usecases/stock/ListStockUsecase';
import { AuditEventView } from '../repositories/interfaces/IAuditRepository';
import { TopSkuRow } from '../repositories/interfaces/IReportRepository';
import { OverviewItem, ReplenishmentSuggestion, SalesSummary } from '../usecases/insight/InsightUsecases';
import { ReorderLevelView } from '../repositories/interfaces/IReorderLevelRepository';
import { MovementView } from '../repositories/interfaces/IStockQueryRepository';

export function toUserResponse(user: User) {
    return {
        id: user.getId(),
        email: user.getEmail(),
        fullName: user.getFullName(),
        role: user.getRole(),
        isActive: user.isActive(),
        hasPassword: user.hasPassword(),
        deactivatedAt: user.getDeactivatedAt(),
        createdAt: user.getCreatedAt(),
        updatedAt: user.getUpdatedAt(),
    };
}

export function toBranchResponse(branch: BranchModel) {
    return {
        id: branch.getId(),
        code: branch.getCode(),
        name: branch.getName(),
        kind: branch.getKind(),
        isActive: branch.isActive(),
        createdAt: branch.getCreatedAt(),
    };
}

export function toStyleResponse(style: Style) {
    return {
        id: style.getId(),
        code: style.getCode(),
        name: style.getName(),
        category: style.getCategory(),
        isActive: style.isActive(),
        createdAt: style.getCreatedAt(),
        updatedAt: style.getUpdatedAt(),
    };
}

export function toSkuResponse(sku: Sku) {
    return {
        id: sku.getId(),
        styleId: sku.getStyleId(),
        skuCode: sku.getSkuCode(),
        size: sku.getSize(),
        color: sku.getColor(),
        standardPrice: sku.getStandardPrice(),
        currency: sku.getCurrency(),
        isActive: sku.isActive(),
        createdAt: sku.getCreatedAt(),
        updatedAt: sku.getUpdatedAt(),
    };
}

export function toSkuWithStyleResponse({ sku, style }: SkuWithStyle) {
    return { ...toSkuResponse(sku), style: { id: style.getId(), code: style.getCode(), name: style.getName() } };
}

export function toBarcodeResponse(barcode: Barcode) {
    return { id: barcode.getId(), skuId: barcode.getSkuId(), code: barcode.getCode(), createdAt: barcode.getCreatedAt() };
}

export function toSkuDetailResponse(detail: SkuDetail) {
    return { ...toSkuWithStyleResponse(detail), barcodes: detail.barcodes.map(toBarcodeResponse) };
}

export function toPriceChangeResponse(change: PriceChange) {
    return {
        id: change.id,
        skuId: change.skuId,
        oldPrice: change.oldPriceCents === null ? null : formatCents(change.oldPriceCents),
        newPrice: formatCents(change.newPriceCents),
        effectiveAt: change.effectiveAt,
        changedBy: change.changedBy,
    };
}

export function toSaleResponse(sale: SaleView) {
    const totalPaid = sale.payments.reduce((sum, p) => sum + p.amountCents, 0);
    return {
        id: sale.id,
        reference: sale.reference,
        branchId: sale.branchId,
        soldBy: { id: sale.soldBy, name: sale.soldByName },
        status: sale.status,
        channel: sale.channel,
        socialPlatform: sale.socialPlatform,
        currency: sale.currency,
        subtotal: formatCents(sale.subtotalCents),
        totalDiscount: formatCents(sale.discountCents),
        total: formatCents(sale.totalCents),
        totalPaid: formatCents(totalPaid),
        soldAt: sale.soldAt,
        businessDate: sale.businessDate,
        note: sale.note,
        lines: sale.lines.map((line) => ({
            lineNo: line.lineNo,
            skuId: line.skuId,
            skuCode: line.skuCode,
            styleName: line.styleName,
            size: line.size,
            color: line.color,
            quantity: line.quantity,
            unitPrice: formatCents(line.unitPriceCents),
            discount: line.reduction
                ? line.reduction.type === 'percent'
                    ? { type: 'percent', percent: formatCents(line.reduction.percentHundredths), reason: line.reduction.reason, approvedBy: line.reduction.approvedBy }
                    : { type: 'override', unitPrice: formatCents(line.reduction.unitPriceCents), reason: line.reduction.reason, approvedBy: line.reduction.approvedBy }
                : null,
            lineTotal: formatCents(line.lineTotalCents),
        })),
        payments: sale.payments.map((p) => ({
            method: p.method,
            amount: formatCents(p.amountCents),
            tendered: p.tenderedCents === null ? null : formatCents(p.tenderedCents),
            change: p.tenderedCents === null ? null : formatCents(p.tenderedCents - p.amountCents),
            reference: p.whishReference,
        })),
    };
}

export function toStockItemResponse(item: StockItem) {
    return {
        sku: toSkuWithStyleResponse(item.sku),
        sellable: item.level.sellable,
        nonSellable: item.level.nonSellable,
        inTransit: item.level.inTransit,
    };
}


const toLocationResponse = (branch: BranchModel) => ({ id: branch.getId(), code: branch.getCode(), name: branch.getName(), kind: branch.getKind() });

export function toOverviewResponse(overview: { locations: BranchModel[]; items: OverviewItem[] }) {
    return {
        locations: overview.locations.map(toLocationResponse),
        items: overview.items.map((item) => ({
            sku: toSkuWithStyleResponse(item.sku),
            totals: item.totals,
            locations: item.locations.map((l) => ({
                branchId: l.branch.getId(), sellable: l.quantities.sellable, nonSellable: l.quantities.nonSellable, inTransit: l.quantities.inTransit,
                minQuantity: l.minQuantity, targetQuantity: l.targetQuantity, belowMinimum: l.belowMinimum,
            })),
        })),
    };
}

export const toMovementResponse = (m: MovementView) => ({
    id: m.id, occurredAt: m.occurredAt, type: m.movementType, bucket: m.bucket, quantityDelta: m.quantityDelta, balanceAfter: m.balanceAfter,
    sku: { id: m.skuId, code: m.skuCode }, by: { id: m.actorId, name: m.actorName }, saleId: m.saleId, reason: m.reason,
});

export const toReorderLevelResponse = (l: ReorderLevelView) => ({
    id: l.id, branchId: l.branchId, sku: { id: l.skuId, code: l.skuCode, styleName: l.styleName, size: l.size, color: l.color },
    minQuantity: l.minQuantity, targetQuantity: l.targetQuantity, updatedAt: l.updatedAt,
});

export function toSuggestionsResponse(result: { warehouse: BranchModel | null; suggestions: ReplenishmentSuggestion[] }) {
    return {
        warehouse: result.warehouse ? toLocationResponse(result.warehouse) : null,
        suggestions: result.suggestions.map((s) => ({
            branch: toLocationResponse(s.branch),
            sku: { id: s.row.skuId, code: s.row.skuCode, styleName: s.row.styleName, size: s.row.size, color: s.row.color },
            sellable: s.row.sellable, inTransit: s.row.inTransit, minQuantity: s.row.minQuantity, targetQuantity: s.row.targetQuantity,
            suggested: s.suggested, warehouseSellable: s.warehouseSellable, fillable: s.fillable,
        })),
    };
}

const money = (r: { revenueCents: number; discountCents: number; cashCents: number; whishCents: number; inStoreCents: number; socialMediaCents: number }) => ({
    revenue: formatCents(r.revenueCents), discounts: formatCents(r.discountCents), cash: formatCents(r.cashCents), whish: formatCents(r.whishCents),
    inStore: formatCents(r.inStoreCents), socialMedia: formatCents(r.socialMediaCents),
});

export function toSalesSummaryResponse(summary: SalesSummary) {
    const names = new Map(summary.branches.map((b) => [b.getId(), toLocationResponse(b)]));
    return {
        from: summary.from, to: summary.to,
        totals: { salesCount: summary.totals.salesCount, items: summary.totals.items, ...money(summary.totals) },
        rows: summary.rows.map((r) => ({ day: r.day, branch: names.get(r.branchId) ?? { id: r.branchId }, salesCount: r.salesCount, items: r.items, ...money(r) })),
    };
}

export const toTopSkuResponse = (r: TopSkuRow) => ({
    sku: { id: r.skuId, code: r.skuCode, styleName: r.styleName, size: r.size, color: r.color }, quantity: r.quantity, revenue: formatCents(r.revenueCents), salesCount: r.salesCount,
});

export const toAuditResponse = (e: AuditEventView) => ({
    id: e.id, occurredAt: e.occurredAt, action: e.action, entityType: e.entityType, entityId: e.entityId, branchId: e.branchId,
    by: { id: e.actorId, name: e.actorName }, details: e.details,
});
