import { Prisma, PrismaClient } from '../generated/prisma/client';
import { BranchMapper } from '../mapper/Branch.mapper';
import { Branch } from '../models/Branch.model';
import { ConflictError } from '../utils/exeptions/ConflictError';
import { writeAudit } from './audit';
import { ILocationRepository } from './interfaces/ILocationRepository';

export class LocationRepository implements ILocationRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async findWarehouse(): Promise<Branch | null> {
        const raw = await this.prisma.branch.findFirst({ where: { kind: 'WAREHOUSE' } });
        return raw ? BranchMapper.toDomain(raw) : null;
    }

    async hasActivity(branchId: string): Promise<boolean> {
        const [sale, level] = await Promise.all([
            this.prisma.sale.findFirst({ where: { branchId }, select: { id: true } }),
            this.prisma.reorderLevel.findFirst({ where: { branchId }, select: { id: true } }),
        ]);
        return sale !== null || level !== null;
    }

    async updateAudited(branch: Branch, actorId: string, details: Record<string, unknown>): Promise<Branch> {
        try {
            return await this.prisma.$transaction(async (tx) => {
                const raw = await tx.branch.update({ where: { id: branch.getId() }, data: BranchMapper.toUpdateData(branch, actorId) });
                await writeAudit(tx, { actorId, action: 'branch.update', entityType: 'branch', entityId: branch.getId(), branchId: branch.getId(), details });
                return BranchMapper.toDomain(raw);
            });
        } catch (error) {
            // the unique index allows ONE warehouse, even when two admins try at the same moment
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                throw new ConflictError('There is already a warehouse');
            }
            throw error;
        }
    }
}
