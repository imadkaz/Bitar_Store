import { randomUUID } from 'node:crypto';
import { Branch, normalizeBranchCode, normalizeBranchKind } from '../../models/Branch.model';
import { IBranchRepository } from '../../repositories/interfaces/IBranchRepository';
import { ILocationRepository } from '../../repositories/interfaces/ILocationRepository';
import { ConflictError } from '../../utils/exeptions/ConflictError';

export interface CreateBranchInput {
    code: string;
    name: string;
    kind?: unknown;      // 'branch' (default) or 'warehouse': the main inventory, only one
}

export class CreateBranchUsecase {
    constructor(
        private readonly branchRepository: IBranchRepository,
        private readonly locations?: ILocationRepository,
    ) { }

    async execute(input: CreateBranchInput, actorId: string): Promise<Branch> {
        const code = normalizeBranchCode(input.code);
        if (await this.branchRepository.findByCode(code)) {
            throw new ConflictError('A branch with this code already exists');
        }
        const kind = input.kind === undefined ? normalizeBranchKind('branch') : normalizeBranchKind(input.kind);
        if (kind === 'warehouse' && this.locations && (await this.locations.findWarehouse())) {
            throw new ConflictError('There is already a warehouse');
        }
        const branch = Branch.create({ id: randomUUID(), code, name: input.name, kind });
        return this.branchRepository.save(branch, actorId);
    }
}
