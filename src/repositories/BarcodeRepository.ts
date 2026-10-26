import { Prisma, PrismaClient } from '../generated/prisma/client';
import { SkuMapper } from '../mapper/Sku.Mapper';
import { Barcode } from '../models/Barcode.model';
import { ConflictError } from '../utils/exeptions/ConflictError';
import { IBarcodeRepository } from './interfaces/IBarcodeRepository';

export class BarcodeRepository implements IBarcodeRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async findById(id: string): Promise<Barcode | null> {
        const raw = await this.prisma.barcode.findUnique({ where: { id } });
        return raw ? SkuMapper.barcodeToDomain(raw) : null;
    }

    async findByCode(code: string): Promise<Barcode | null> {
        const raw = await this.prisma.barcode.findFirst({ where: { code } });
        return raw ? SkuMapper.barcodeToDomain(raw) : null;
    }

    async listBySku(skuId: string): Promise<Barcode[]> {
        const rows = await this.prisma.barcode.findMany({ where: { skuId }, orderBy: { createdAt: 'asc' } });
        return rows.map(SkuMapper.barcodeToDomain);
    }

    async save(barcode: Barcode, actorId: string | null): Promise<Barcode> {
        try {
            const raw = await this.prisma.barcode.create({
                data: { id: barcode.getId(), skuId: barcode.getSkuId(), code: barcode.getCode(), createdBy: actorId },
            });
            return SkuMapper.barcodeToDomain(raw);
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                throw new ConflictError('This barcode already belongs to a sku');
            }
            throw error;
        }
    }

    async delete(id: string): Promise<void> {
        await this.prisma.barcode.deleteMany({ where: { id } });   // nothing points at a barcode, so it can always go
    }
}
