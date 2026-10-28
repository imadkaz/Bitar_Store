import { Branch } from '../models/Branch.model';
import { User } from '../models/User.model';
import { Barcode } from '../models/Barcode.model';
import { PriceChange, Sku } from '../models/Sku.model';
import { Style } from '../models/Style.model';
import { formatCents } from '../models/Money';
import { SkuWithStyle } from '../repositories/interfaces/ISkuRepository';
import { SkuDetail } from '../usecases/skus/GetSkuUsecase';
import { SaleView } from '../repositories/interfaces/ISaleRepository';
import { StockItem } from '../usecases/stock/ListStockUsecase';

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

export function toBranchResponse(branch: Branch) {
    return {
        id: branch.getId(),
        code: branch.getCode(),
        name: branch.getName(),
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
