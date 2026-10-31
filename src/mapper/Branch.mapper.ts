import { Branch as PrismaBranch, Prisma } from '../generated/prisma/client';
import { Branch, BranchKind } from '../models/Branch.model';

export class BranchMapper {
    static toDomain(raw: PrismaBranch): Branch {
        return Branch.create({
            id: raw.id,
            code: raw.code,
            name: raw.name,
            kind: raw.kind as BranchKind,
            isActive: raw.isActive,
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt,
        });
    }

    static toPersistence(branch: Branch, actorId: string | null): Prisma.BranchUncheckedCreateInput {
        return {
            id: branch.getId(),
            code: branch.getCode(),
            name: branch.getName(),
            kind: branch.getKind(),
            isActive: branch.isActive(),
            createdBy: actorId,
            updatedBy: actorId,
        };
    }

    static toUpdateData(branch: Branch, actorId: string | null): Prisma.BranchUncheckedUpdateInput {
        return { name: branch.getName(), isActive: branch.isActive(), kind: branch.getKind(), updatedBy: actorId };    }
    }
