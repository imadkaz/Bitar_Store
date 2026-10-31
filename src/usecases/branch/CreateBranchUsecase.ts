import { randomUUID } from 'node:crypto';
import { Branch, BranchKind, normalizeBranchCode } from '../../models/Branch.model';
import { IBranchRepository } from '../../repositories/interfaces/IBranchRepository';
import { ConflictError } from '../../utils/exeptions/ConflictError';

export interface CreateBranchInput {
    code: string;
    name: string;
    kind: BranchKind;
}

export class CreateBranchUsecase {
    constructor(private readonly branchRepository: IBranchRepository) {}

    async execute(input: CreateBranchInput, actorId: string): Promise<Branch> {
        const code = normalizeBranchCode(input.code);
        if (await this.branchRepository.findByCode(code)) {
            throw new ConflictError('A branch with this code already exists');
        }
        const branch = Branch.create({ id: randomUUID(), code, name: input.name, kind: input.kind });
        return this.branchRepository.save(branch, actorId);
    }
}
