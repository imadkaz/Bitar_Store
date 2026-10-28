import { createHash } from 'node:crypto';
import { AuthContext } from '../../models/AuthContext';
import { IBranchRepository } from '../../repositories/interfaces/IBranchRepository';
import { ISkuRepository } from '../../repositories/interfaces/ISkuRepository';
import { IStockRepository } from '../../repositories/interfaces/IStockRepository';
import { ConflictError } from '../../utils/exeptions/ConflictError';
import { ForbiddenError } from '../../utils/exeptions/ForbiddenError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { isUuid } from '../../utils/uuid';
import { parseIdempotencyKey } from '../sales/saleRequest';

const MAX_LINES = 500;
const MAX_QUANTITY = 1_000_000;

export class SetOpeningStockUsecase {
    constructor(
        private readonly branchRepository: IBranchRepository,
        private readonly skuRepository: ISkuRepository,
        private readonly stockRepository: IStockRepository,
    ) {}

    async execute(body: unknown, idempotencyKeyHeader: unknown, auth: AuthContext): Promise<{ batchId: string; replayed: boolean; lines: number }> {
        if (!auth.can('adjustments.create')) throw new ForbiddenError('Missing permission: adjustments.create');
        const idempotencyKey = parseIdempotencyKey(idempotencyKeyHeader);

        const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
        if (typeof input.branchId !== 'string' || !isUuid(input.branchId)) throw new ValidationError('branchId must be the id of a branch');
        if (!Array.isArray(input.lines) || input.lines.length === 0) throw new ValidationError('lines must be a list with at least one item');
        if (input.lines.length > MAX_LINES) throw new ValidationError(`At most ${MAX_LINES} lines at a time`);

        const lines = input.lines.map((raw, index) => {
            const line = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
            if (typeof line.skuId !== 'string' || !isUuid(line.skuId)) throw new ValidationError(`Line ${index + 1}: skuId must be the id of a sku`);
            if (!Number.isInteger(line.quantity) || (line.quantity as number) < 1 || (line.quantity as number) > MAX_QUANTITY) {
                throw new ValidationError(`Line ${index + 1}: quantity must be a whole number between 1 and ${MAX_QUANTITY}`);
            }
            return { skuId: line.skuId, quantity: line.quantity as number };
        });
        if (new Set(lines.map((l) => l.skuId)).size !== lines.length) throw new ValidationError('Each sku can appear only once');

        if (!auth.canAccessBranch(input.branchId)) throw new ForbiddenError('You cannot change the stock of this branch');
        const branch = await this.branchRepository.findById(input.branchId);
        if (!branch) throw new NotFoundError('Branch not found');
        if (!branch.isActive()) throw new ConflictError('This branch is inactive');
        for (const line of lines) {
            if (!(await this.skuRepository.findById(line.skuId))) throw new NotFoundError('Sku not found');
        }

        const requestHash = createHash('sha256').update(JSON.stringify({ b: input.branchId, l: lines.map((l) => [l.skuId, l.quantity]) })).digest('hex');
        const result = await this.stockRepository.recordOpening({ branchId: input.branchId, actorId: auth.user.getId(), idempotencyKey, requestHash, lines });
        return { ...result, lines: lines.length };
    }
}
