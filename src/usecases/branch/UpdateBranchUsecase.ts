import { Branch, BranchKind, normalizeBranchKind } from '../../models/Branch.model';
import { IBranchRepository } from '../../repositories/interfaces/IBranchRepository';
import { ILocationRepository } from '../../repositories/interfaces/ILocationRepository';
import { ConflictError } from '../../utils/exeptions/ConflictError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { isUuid } from '../../utils/uuid';

export class UpdateBranchUsecase {
    constructor(private readonly branches: IBranchRepository, private readonly locations: ILocationRepository) { }

    // Admin only (the route says so). Name, active flag and kind: what changed is written together with its audit event.
    async execute(id: string, body: unknown, actorId: string): Promise<Branch> {
        if (!isUuid(id)) throw new NotFoundError('Branch not found');
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ValidationError('The request body is required');
        const input = body as Record<string, unknown>;
        const known = ['name', 'isActive', 'kind'];
        const unknown = Object.keys(input).filter((k) => !known.includes(k));
        if (unknown.length > 0) throw new ValidationError(`You can change only: ${known.join(', ')}`);
        if (Object.keys(input).length === 0) throw new ValidationError('Nothing to change');

        const branch = await this.branches.findById(id);
        if (!branch) throw new NotFoundError('Branch not found');
        const before = { name: branch.getName(), isActive: branch.isActive(), kind: branch.getKind() };

        if (input.name !== undefined) branch.rename(input.name as string);
        if (input.isActive !== undefined) {
            if (typeof input.isActive !== 'boolean') throw new ValidationError('isActive must be true or false');
            if (input.isActive) branch.activate();
            else branch.deactivate();
        }
        if (input.kind !== undefined) {
            const kind = normalizeBranchKind(input.kind);
            if (kind === BranchKind.WAREHOUSE && !branch.isWarehouse()) {
                const existing = await this.locations.findWarehouse();
                if (existing && existing.getId() !== branch.getId()) throw new ConflictError('There is already a warehouse');
                if (await this.locations.hasActivity(branch.getId())) throw new ConflictError('This branch already has sales or minimum levels: it cannot become the warehouse');
            }
            branch.setKind(kind);
        }

        const after = { name: branch.getName(), isActive: branch.isActive(), kind: branch.getKind() };
        if (JSON.stringify(before) === JSON.stringify(after)) return branch;       // nothing really changed: no write, no audit event
        return this.locations.updateAudited(branch, actorId, { before, after });
    }
}
