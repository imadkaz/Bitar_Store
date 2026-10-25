import { Prisma, PrismaClient } from '../generated/prisma/client';
import { BranchMapper } from '../mapper/Branch.mapper';
import { Branch } from '../models/Branch.model';
import { ConflictError } from '../utils/exeptions/ConflictError';
import { IBranchRepository } from './interfaces/IBranchRepository';

export class BranchRepository implements IBranchRepository {
    constructor(private readonly prisma: PrismaClient) { }

    async findById(id: string): Promise<Branch | null> {
        const raw = await this.prisma.branch.findUnique({ where: { id } });
        return raw ? BranchMapper.toDomain(raw) : null;
    }

    async findByCode(code: string): Promise<Branch | null> {
        const raw = await this.prisma.branch.findFirst({ where: { code } });
        return raw ? BranchMapper.toDomain(raw) : null;
    }

    async findByIds(ids: string[]): Promise<Branch[]> {
        if (ids.length === 0) return [];
        const rows = await this.prisma.branch.findMany({ where: { id: { in: ids } }, orderBy: { code: 'asc' } });
        return rows.map(BranchMapper.toDomain);
    }

    async list(): Promise<Branch[]> {
        const rows = await this.prisma.branch.findMany({ orderBy: { code: 'asc' } });
        return rows.map(BranchMapper.toDomain);
    }

    async save(branch: Branch, actorId: string | null): Promise<Branch> {
        try {
            const raw = await this.prisma.branch.create({ data: BranchMapper.toPersistence(branch, actorId) });
            return BranchMapper.toDomain(raw);
        } catch (error ) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && (error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
                throw new ConflictError('A branch with this code already exists');
            }
            throw error;
        }
    }

    async update(branch: Branch, actorId: string | null): Promise<Branch> {
        const raw = await this.prisma.branch.update({
            where: { id: branch.getId() },
            data: BranchMapper.toUpdateData(branch, actorId),
        });
        return BranchMapper.toDomain(raw);
    }
}
