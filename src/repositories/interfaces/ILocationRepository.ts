import { Branch } from '../../models/Branch.model';

// What the warehouse rules need to know about a place, and the one write that must be audited with the change.
export interface ILocationRepository {
    findWarehouse(): Promise<Branch | null>;
    // true when the branch already has sales or minimum levels (it can no longer become the warehouse)
    hasActivity(branchId: string): Promise<boolean>;
    // the branch update and its audit event are written in ONE transaction
    updateAudited(branch: Branch, actorId: string, details: Record<string, unknown>): Promise<Branch>;
}
