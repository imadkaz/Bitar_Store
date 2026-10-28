import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../generated/prisma/client';
import { ConflictError } from '../utils/exeptions/ConflictError';
import { claimIdempotencyKey, completeIdempotencyKey } from './idempotency';
import { IStockRepository, OpeningStockCommand, OpeningStockResult, StockLevel } from './interfaces/IStockRepository';

export class StockRepository implements IStockRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async getLevels(branchId: string, skuIds: string[]): Promise<Map<string, StockLevel>> {
        const levels = new Map<string, StockLevel>(skuIds.map((skuId) => [skuId, { skuId, sellable: 0, nonSellable: 0, inTransit: 0 }]));
        const rows = await this.prisma.stockBalance.findMany({ where: { branchId, skuId: { in: skuIds } } });
        for (const row of rows) {
            const level = levels.get(row.skuId)!;
            if (row.bucket === 'sellable') level.sellable = row.quantity;
            else if (row.bucket === 'non_sellable') level.nonSellable = row.quantity;
            else if (row.bucket === 'in_transit') level.inTransit = row.quantity;
        }
        return levels;
    }

    // Opening stock = the quantities counted the day the system starts. Allowed only for a sku that has NO movement yet
    // at that branch: after that, quantities change only through sales, transfers and adjustments.
    async recordOpening(command: OpeningStockCommand): Promise<OpeningStockResult> {
        return this.prisma.$transaction(
            async (tx) => {
                const claim = await claimIdempotencyKey(tx, command.actorId, 'stock.opening', command.idempotencyKey, command.requestHash);
                if (claim.kind === 'replay') return { batchId: claim.resourceId, replayed: true };
                if (claim.kind === 'different_request') throw new ConflictError('This Idempotency-Key was already used for a different request');
                if (claim.kind === 'in_progress') throw new ConflictError('This request is already being processed');

                const batchId = randomUUID();
                for (const line of [...command.lines].sort((a, b) => a.skuId.localeCompare(b.skuId))) {
                    const already = await tx.stockMovement.findFirst({ where: { skuId: line.skuId, branchId: command.branchId }, select: { id: true } });
                    if (already) throw new ConflictError('Opening stock can only be set for a sku that has no movement yet at this branch');
                    await tx.stockBalance.create({ data: { skuId: line.skuId, branchId: command.branchId, bucket: 'sellable', quantity: line.quantity } });
                    await tx.stockMovement.create({
                        data: {
                            skuId: line.skuId,
                            branchId: command.branchId,
                            bucket: 'sellable',
                            movementType: 'opening',
                            quantityDelta: line.quantity,
                            balanceAfter: line.quantity,
                            importBatchId: batchId,
                            reason: 'opening stock',
                            actorUserId: command.actorId,
                            idempotencyKeyId: claim.keyId,
                        },
                    });
                }
                await completeIdempotencyKey(tx, claim.keyId, 'import_batch', batchId);
                return { batchId, replayed: false };
            },
            { maxWait: 10_000, timeout: 30_000 },
        );
    }
}
