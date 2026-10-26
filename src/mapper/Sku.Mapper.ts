import { Barcode as PrismaBarcode, Prisma, Sku as PrismaSku, SkuPriceHistory as PrismaPriceHistory } from '../generated/prisma/client';
import { Barcode } from '../models/Barcode.model';
import { parseMoneyToCents } from '../models/Money';
import { PriceChange, Sku } from '../models/Sku.model';
import { formatCents } from '../models/Money';

// numeric(12,2) comes back as a Decimal: go through its 2-decimal text to get exact cents
const centsOf = (value: Prisma.Decimal): number => parseMoneyToCents(value.toFixed(2), 'Price');
const decimalOf = (cents: number): Prisma.Decimal => new Prisma.Decimal(formatCents(cents));

export class SkuMapper {
    static toDomain(raw: PrismaSku): Sku {
        return Sku.create({
            id: raw.id,
            styleId: raw.styleId,
            skuCode: raw.skuCode,
            size: raw.size,
            color: raw.color,
            standardPriceCents: centsOf(raw.standardPrice),
            currency: raw.currency,
            isActive: raw.isActive,
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt,
        });
    }

    static toPersistence(sku: Sku, actorId: string | null): Prisma.SkuUncheckedCreateInput {
        return {
            id: sku.getId(),
            styleId: sku.getStyleId(),
            skuCode: sku.getSkuCode(),
            size: sku.getSize(),
            color: sku.getColor(),
            standardPrice: decimalOf(sku.getStandardPriceCents()),
            currency: sku.getCurrency(),
            isActive: sku.isActive(),
            createdBy: actorId,
            updatedBy: actorId,
        };
    }

    // size, color and the active flag only: the price has its own path (history row + lock)
    static toUpdateData(sku: Sku, actorId: string | null): Prisma.SkuUncheckedUpdateInput {
        return { size: sku.getSize(), color: sku.getColor(), isActive: sku.isActive(), updatedBy: actorId };
    }

    static priceToDecimal(cents: number): Prisma.Decimal {
        return decimalOf(cents);
    }

    static priceChangeToDomain(raw: PrismaPriceHistory): PriceChange {
        return {
            id: raw.id,
            skuId: raw.skuId,
            oldPriceCents: raw.oldPrice ? centsOf(raw.oldPrice) : null,
            newPriceCents: centsOf(raw.newPrice),
            effectiveAt: raw.effectiveAt,
            changedBy: raw.changedBy,
        };
    }

    static barcodeToDomain(raw: PrismaBarcode): Barcode {
        return Barcode.create({ id: raw.id, skuId: raw.skuId, code: raw.code, createdAt: raw.createdAt });
    }
}
