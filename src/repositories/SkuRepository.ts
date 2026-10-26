import { Prisma, PrismaClient } from '../generated/prisma/client';
import { SkuMapper } from '../mapper/Sku.Mapper';
import { StyleMapper } from '../mapper/Style.Mapper';
import { PriceChange, Sku } from '../models/Sku.model';
import { ConflictError } from '../utils/exeptions/ConflictError';
import { NotFoundError } from '../utils/exeptions/NotFoundError';
import { ISkuRepository, SkuFilter, SkuWithStyle } from './interfaces/ISkuRepository';

export class SkuRepository implements ISkuRepository {
    constructor(private readonly prisma: PrismaClient) {}

    private static withStyle(raw: Prisma.SkuGetPayload<{ include: { style: true } }>): SkuWithStyle {
        return { sku: SkuMapper.toDomain(raw), style: StyleMapper.toDomain(raw.style) };
    }

    async findById(id: string): Promise<Sku | null> {
        const raw = await this.prisma.sku.findUnique({ where: { id } });
        return raw ? SkuMapper.toDomain(raw) : null;
    }

    async findWithStyleById(id: string): Promise<SkuWithStyle | null> {
        const raw = await this.prisma.sku.findUnique({ where: { id }, include: { style: true } });
        return raw ? SkuRepository.withStyle(raw) : null;
    }

    async findBySkuCode(code: string): Promise<Sku | null> {
        const raw = await this.prisma.sku.findFirst({ where: { skuCode: code } });
        return raw ? SkuMapper.toDomain(raw) : null;
    }

    async findByVariant(styleId: string, size: string, color: string, excludeId?: string): Promise<Sku | null> {
        const raw = await this.prisma.sku.findFirst({
            where: {
                styleId,
                size: { equals: size.trim(), mode: 'insensitive' },
                color: { equals: color.trim(), mode: 'insensitive' },
                ...(excludeId ? { id: { not: excludeId } } : {}),
            },
        });
        return raw ? SkuMapper.toDomain(raw) : null;
    }

    async findByBarcode(code: string): Promise<SkuWithStyle | null> {
        const barcode = await this.prisma.barcode.findFirst({
            where: { code },
            include: { sku: { include: { style: true } } },
        });
        return barcode ? SkuRepository.withStyle(barcode.sku) : null;
    }

    async list(filter: SkuFilter): Promise<SkuWithStyle[]> {
        const rows = await this.prisma.sku.findMany({
            where: {
                ...(filter.styleId ? { styleId: filter.styleId } : {}),
                ...(filter.activeOnly ? { isActive: true } : {}),
                ...(filter.search
                    ? {
                          OR: [
                              { skuCode: { contains: filter.search, mode: 'insensitive' } },
                              { color: { contains: filter.search, mode: 'insensitive' } },
                              { style: { name: { contains: filter.search, mode: 'insensitive' } } },
                          ],
                      }
                    : {}),
            },
            include: { style: true },
            orderBy: { skuCode: 'asc' },
            take: filter.limit,
            skip: filter.offset,
        });
        return rows.map(SkuRepository.withStyle);
    }

    async listByStyle(styleId: string): Promise<Sku[]> {
        const rows = await this.prisma.sku.findMany({ where: { styleId }, orderBy: { skuCode: 'asc' } });
        return rows.map(SkuMapper.toDomain);
    }

    async save(sku: Sku, actorId: string): Promise<Sku> {
        try {
            // the sku and its first price-history row are written together or not at all
            const [raw] = await this.prisma.$transaction([
                this.prisma.sku.create({ data: SkuMapper.toPersistence(sku, actorId) }),
                this.prisma.skuPriceHistory.create({
                    data: {
                        skuId: sku.getId(),
                        oldPrice: null,
                        newPrice: SkuMapper.priceToDecimal(sku.getStandardPriceCents()),
                        changedBy: actorId,
                    },
                }),
            ]);
            return SkuMapper.toDomain(raw);
        } catch (error) {
            // two requests can pass the "free" checks at once: the unique indexes (code, variant) have the last word
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                throw new ConflictError('A sku with this code, or with the same size and color in this style, already exists');
            }
            throw error;
        }
    }

    async update(sku: Sku, actorId: string): Promise<Sku> {
        try {
            const raw = await this.prisma.sku.update({ where: { id: sku.getId() }, data: SkuMapper.toUpdateData(sku, actorId) });
            return SkuMapper.toDomain(raw);
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                throw new ConflictError('This style already has a sku with the same size and color');
            }
            throw error;
        }
    }

    async changePrice(sku: Sku, actorId: string): Promise<Sku> {
        return this.prisma.$transaction(async (tx) => {
            // FOR UPDATE: anyone else changing this price waits here, so the "old price" we record is the true one
            const current = await tx.$queryRaw<{ standard_price: Prisma.Decimal }[]>`
                SELECT standard_price FROM skus WHERE id = ${sku.getId()}::uuid FOR UPDATE`;
            if (current.length === 0) throw new NotFoundError('Sku not found');

            const raw = await tx.sku.update({
                where: { id: sku.getId() },
                data: { standardPrice: SkuMapper.priceToDecimal(sku.getStandardPriceCents()), updatedBy: actorId },
            });
            await tx.skuPriceHistory.create({
                data: {
                    skuId: sku.getId(),
                    oldPrice: current[0].standard_price,
                    newPrice: SkuMapper.priceToDecimal(sku.getStandardPriceCents()),
                    changedBy: actorId,
                },
            });
            return SkuMapper.toDomain(raw);
        });
    }

    async listPriceHistory(skuId: string, limit: number): Promise<PriceChange[]> {
        const rows = await this.prisma.skuPriceHistory.findMany({
            where: { skuId },
            orderBy: { effectiveAt: 'desc' },
            take: limit,
        });
        return rows.map(SkuMapper.priceChangeToDomain);
    }
}
