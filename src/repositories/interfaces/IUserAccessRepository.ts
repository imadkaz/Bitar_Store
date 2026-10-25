import { PermissionOverride } from '../../models/Permission';

export interface IUserAccessRepository {
    findBranchIds(userId: string): Promise<string[]>;
    findOverrides(userId: string): Promise<PermissionOverride[]>;
    grantBranch(userId: string, branchId: string, grantedBy: string | null): Promise<void>;   
    revokeBranch(userId: string, branchId: string): Promise<void>;                           
}
