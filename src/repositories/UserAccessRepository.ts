import { PrismaClient } from '../generated/prisma/client';
import { OverrideEffect, Permission, PermissionOverride } from '../models/Permission';
import { IUserAccessRepository } from './interfaces/IUserAccessRepository';

export class UserAccessRepository implements IUserAccessRepository {
    constructor(private readonly prisma: PrismaClient) { }

    async findBranchIds(userId: string): Promise<string[]> {
    // a manager appointed to ALL branches reaches every branch (never the warehouse), also the ones created later
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { allBranches: true } });
    if (user?.allBranches) return (await this.prisma.branch.findMany({ where: { kind: 'branch' }, select: { id: true } })).map((b) => b.id);

    const rows = await this.prisma.userBranchAccess.findMany({ where: { userId } });
    return rows.map((r: { branchId: string }) => r.branchId);
}

    async findOverrides(userId: string): Promise<PermissionOverride[]> {
        const rows = await this.prisma.userPermissionOverride.findMany({ where: { userId } });
        // the database CHECK constraints already guarantee valid values
        return rows.map((r: { permission: unknown; effect: unknown }) => ({ permission: r.permission as Permission, effect: r.effect as OverrideEffect }));
    }

    async grantBranch(userId: string, branchId: string, grantedBy: string | null): Promise<void> {
        await this.prisma.userBranchAccess.upsert({
            where: { userId_branchId: { userId, branchId } },
            create: { userId, branchId, grantedBy },
            update: {},
        });
    }

    async revokeBranch(userId: string, branchId: string): Promise<void> {
        await this.prisma.userBranchAccess.deleteMany({ where: { userId, branchId } });
    }
}
