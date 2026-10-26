import { Branch } from '../models/Branch.model';
import { User } from '../models/User.model';
import { Barcode } from '../models/Barcode.model';
import { PriceChange, Sku } from '../models/Sku.model';
import { Style } from '../models/Style.model';
import { formatCents } from '../models/Money';
import { SkuWithStyle } from '../repositories/interfaces/ISkuRepository';
import { SkuDetail } from '../usecases/skus/GetSkuUsecase';

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

