import { randomUUID } from 'node:crypto';
import { AuthContext } from '../../models/AuthContext';
import { Sale } from '../../models/Sale.model';
import { IBranchRepository } from '../../repositories/interfaces/IBranchRepository';
import { ISaleRepository, SaleView } from '../../repositories/interfaces/ISaleRepository';
import { ISalesUnitOfWork } from '../../repositories/interfaces/ISalesUnitOfWork';
import { IStockAlertRepository } from '../../repositories/interfaces/IStockAlertRepository';
import { businessDateOf } from '../../utils/businessDate';
import { ConflictError } from '../../utils/exeptions/ConflictError';
import { ForbiddenError } from '../../utils/exeptions/ForbiddenError';
import { InsufficientStockError, StockShortage } from '../../utils/exeptions/InsufficientStockError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { hashSaleRequest, parseIdempotencyKey, parseSaleRequest, toLineInputs } from './saleRequest';

export interface CreateSaleResult {
    sale: SaleView;
    replayed: boolean;     // true when this exact request had already been completed: nothing new was done
}

export class CreateSaleUsecase {
    constructor(
        private readonly unitOfWork: ISalesUnitOfWork,
        private readonly branchRepository: IBranchRepository,
        private readonly saleRepository: ISaleRepository,
        private readonly alertRepository: IStockAlertRepository,
        private readonly now: () => Date = () => new Date(),
    ) {}

async execute(body: unknown, idempotencyKeyHeader: unknown, auth: AuthContext): Promise<CreateSaleResult> {        const actorId = auth.user.getId();
        if (!auth.can('sales.create')) throw new ForbiddenError('Missing permission: sales.create');

        const idempotencyKey = parseIdempotencyKey(idempotencyKeyHeader);
        const request = parseSaleRequest(body);
        if (!auth.canAccessBranch(request.branchId)) throw new ForbiddenError('You cannot sell at this branch');
        if (request.lines.some((line) => line.discount) && !auth.can('discounts.apply')) {
            throw new ForbiddenError('Missing permission: discounts.apply');   // an employee asks, a manager applies the discount
        }
        const branch = await this.branchRepository.findById(request.branchId);
        if (!branch) throw new NotFoundError('Branch not found');
        if (!branch.isActive()) throw new ConflictError('This branch is inactive');
        if (branch.isWarehouse()) throw new ConflictError('The warehouse does not sell to customers: it supplies the branches');

        const requestHash = hashSaleRequest(request);
        const skuIds = request.lines.map((line) => line.skuId);
        const businessDate = businessDateOf(this.now());
        let shortages: StockShortage[] = [];

        // 2) the sale itself: ONE transaction. Either everything below happens, or nothing does.
        let saleId: string;
        let replayed = false;
        try {
            saleId = await this.unitOfWork.run(async (tx) => {
                const claim = await tx.claimIdempotencyKey(actorId, 'sale.create', idempotencyKey, requestHash);
                if (claim.kind === 'replay') {
                    replayed = true;
                    return claim.resourceId;
                }
                if (claim.kind === 'different_request') throw new ConflictError('This Idempotency-Key was already used for a different request');
                if (claim.kind === 'in_progress') throw new ConflictError('This request is already being processed');

                // prices come from the DATABASE, never from the client
                const found = new Map((await tx.findSkusForSale(skuIds)).map((sku) => [sku.skuId, sku]));
                for (const skuId of skuIds) {
                    const sku = found.get(skuId);
                    if (!sku) throw new NotFoundError('Sku not found');
                    if (!sku.skuActive || !sku.styleActive) throw new ConflictError(`Sku ${sku.skuCode} is not for sale`);
                }
                if (new Set([...found.values()].map((sku) => sku.currency)).size > 1) {
                    throw new ValidationError('All the lines of a sale must be in the same currency');
                }

                const sale = Sale.create({
                    id: randomUUID(),
                    branchId: request.branchId,
                    soldBy: actorId,
                    currency: [...found.values()][0].currency,
                    channel: request.channel,
                    socialPlatform: request.socialPlatform,
                    note: request.note,
                    businessDate,
                    lines: toLineInputs(request, (skuId) => found.get(skuId)!.priceCents, actorId),
                    payments: request.payments,
                });

                // lock first, THEN look at the quantities: nobody can take them between our look and our write
                const available = await tx.lockSellableStock(request.branchId, [...skuIds].sort());
                shortages = sale.lines
                    .filter((line) => (available.get(line.skuId) ?? 0) < line.quantity)
                    .map((line) => ({ skuId: line.skuId, skuCode: found.get(line.skuId)!.skuCode, requested: line.quantity, available: available.get(line.skuId) ?? 0 }));
                if (shortages.length > 0) throw new InsufficientStockError(shortages);

                await tx.insertSale(sale, claim.keyId, actorId);
                await tx.deductStock(request.branchId, sale.id, sale.lines.map((l) => ({ skuId: l.skuId, quantity: l.quantity })), actorId, claim.keyId);
                await tx.completeIdempotencyKey(claim.keyId, 'sale', sale.id);
                return sale.id;
            });
        } catch (error) {
            // the transaction was rolled back, so the alert is written separately, afterwards
            if (error instanceof InsufficientStockError) {
                await this.alertRepository.recordInsufficient(
                    shortages.map((s) => ({ operation: 'sale.create', branchId: request.branchId, skuId: s.skuId, requestedQuantity: s.requested, availableQuantity: s.available, actorId, idempotencyKey })),
                );
            }
            throw error;
        }

        const sale = await this.saleRepository.findById(saleId);
        return { sale: sale!, replayed };
    }
}
