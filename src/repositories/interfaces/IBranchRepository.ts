import { Branch } from '../../models/Branch.model';

export interface IBranchRepository {
    findById(id: string): Promise<Branch | null>;
    findByCode(code: string): Promise<Branch | null>;
    findByIds(ids: string[]): Promise<Branch[]>;
    list(): Promise<Branch[]>;
    save(branch: Branch, actorId: string | null): Promise<Branch>;
    update(branch: Branch, actorId: string | null): Promise<Branch>;
}
