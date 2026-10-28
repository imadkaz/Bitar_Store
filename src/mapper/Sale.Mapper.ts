import { Prisma } from '../generated/prisma/client';
import { formatCents, parseMoneyToCents } from '../models/Money';
import { Sale } from '../models/Sale.model';

// numeric(12,2) <-> whole cents, without going through floating point
export const decimalOf = (cents: number): Prisma.Decimal => new Prisma.Decimal(formatCents(cents));
export const centsOf = (value: Prisma.Decimal): number => parseMoneyToCents(value.toFixed(2), 'Amount');

export class SaleMapper {
    static toPersistence(sale: Sale, idempotencyKeyId: string, actorId: string): Prisma.SaleCreateInput | Prisma.SaleUncheckedCreateInput {
        return {
            id: sale.id,
            branchId: sale.branchId,
            soldBy: sale.soldBy,
            currency: sale.currency,
            subtotalStandard: decimalOf(sale.subtotalCents),
            totalDiscount: decimalOf(sale.discountCents),
            total: decimalOf(sale.totalCents),
            businessDate: new Date(`${sale.businessDate}T00:00:00.000Z`),
            idempotencyKeyId,
            note: sale.note,
            channel: sale.channel,
            socialPlatform: sale.socialPlatform,
            createdBy: actorId,
            updatedBy: actorId,
            lines: {
                create: sale.lines.map((line) => ({
                    lineNo: line.lineNo,
                    skuId: line.skuId,
                    quantity: line.quantity,
                    unitPriceStandard: decimalOf(line.unitPriceStandardCents),
                    reductionType: line.reduction?.type ?? null,
                    reductionPercent: line.reduction?.type === 'percent' ? new Prisma.Decimal((line.reduction.percentHundredths / 100).toFixed(2)) : null,
                    overrideUnitPrice: line.reduction?.type === 'override' ? decimalOf(line.reduction.unitPriceCents) : null,
                    reductionReason: line.reduction?.reason ?? null,
                    reducedBy: line.reduction?.approvedBy ?? null,
                    lineStandardTotal: decimalOf(line.lineStandardTotalCents),
                    lineTotal: decimalOf(line.lineTotalCents),
                })),
            },
            payments: {
                create: sale.payments.map((payment) => ({
                    method: payment.method,
                    amount: decimalOf(payment.amountCents),
                    cashTendered: payment.tenderedCents === null ? null : decimalOf(payment.tenderedCents),
                    whishReference: payment.whishReference,
                    receivedBy: payment.receivedBy,
                })),
            },
        } as Prisma.SaleUncheckedCreateInput;
    }
}
