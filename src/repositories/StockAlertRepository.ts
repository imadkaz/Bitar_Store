import { PrismaClient } from '../generated/prisma/client';
import { IStockAlertRepository, StockAlertInput } from './interfaces/IStockAlertRepository';

export class StockAlertRepository implements IStockAlertRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async recordInsufficient(alerts: StockAlertInput[]): Promise<void> {
        if (alerts.length === 0) return;
        await this.prisma.stockAlert.createMany({
            data: alerts.map((a) => ({
                alertType: 'insufficient_stock',
                operation: a.operation,
                branchId: a.branchId,
                skuId: a.skuId,
                requestedQuantity: a.requestedQuantity,
                availableQuantity: a.availableQuantity,
                actorUserId: a.actorId,
                idempotencyKey: a.idempotencyKey,
            })),
            skipDuplicates: true,   // the partial unique index: a retry of the same request is the same alert
        });
    }
}
