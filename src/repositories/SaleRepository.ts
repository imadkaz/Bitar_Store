import { PrismaClient } from '../generated/prisma/client';
import { centsOf } from '../mapper/Sale.Mapper';
import { ISaleRepository, SaleListFilter, SaleView } from './interfaces/ISaleRepository';

export class SaleRepository implements ISaleRepository {
    constructor(private readonly prisma: PrismaClient) {}

    private async hydrate(rows: Awaited<ReturnType<SaleRepository['loadRows']>>): Promise<SaleView[]> {
        const skuIds = [...new Set(rows.flatMap((sale) => sale.lines.map((l) => l.skuId)))];
        const userIds = [...new Set(rows.map((sale) => sale.soldBy))];
        const skus = new Map((await this.prisma.sku.findMany({ where: { id: { in: skuIds } }, include: { style: true } })).map((s) => [s.id, s]));
        const users = new Map((await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));

        return rows.map((sale) => ({
            id: sale.id,
            reference: sale.reference,
            branchId: sale.branchId,
            soldBy: sale.soldBy,
            soldByName: users.get(sale.soldBy) ?? null,
            status: sale.status,
            channel: sale.channel,
            socialPlatform: sale.socialPlatform,
            currency: sale.currency,
            subtotalCents: centsOf(sale.subtotalStandard),
            discountCents: centsOf(sale.totalDiscount),
            totalCents: centsOf(sale.total),
            soldAt: sale.soldAt,
            businessDate: sale.businessDate.toISOString().slice(0, 10),
            note: sale.note,
            lines: sale.lines.map((line) => {
                const sku = skus.get(line.skuId)!;
                const reduction =
                    line.reductionType === 'percent'
                        ? { type: 'percent' as const, percentHundredths: Math.round(Number(line.reductionPercent) * 100), reason: line.reductionReason!, approvedBy: line.reducedBy! }
                        : line.reductionType === 'override'
                          ? { type: 'override' as const, unitPriceCents: centsOf(line.overrideUnitPrice!), reason: line.reductionReason!, approvedBy: line.reducedBy! }
                          : null;
                return {
                    lineNo: line.lineNo,
                    skuId: line.skuId,
                    skuCode: sku.skuCode,
                    styleName: sku.style.name,
                    size: sku.size,
                    color: sku.color,
                    quantity: line.quantity,
                    unitPriceCents: centsOf(line.unitPriceStandard),
                    reduction,
                    lineTotalCents: centsOf(line.lineTotal),
                };
            }),
            payments: sale.payments.map((p) => ({
                method: p.method as 'cash' | 'whish',
                amountCents: centsOf(p.amount),
                tenderedCents: p.cashTendered ? centsOf(p.cashTendered) : null,
                whishReference: p.whishReference,
                receivedBy: p.receivedBy,
            })),
        }));
    }

    private loadRows(where: object, take?: number, skip?: number) {
        return this.prisma.sale.findMany({
            where,
            include: { lines: { orderBy: { lineNo: 'asc' } }, payments: { orderBy: { createdAt: 'asc' } } },
            orderBy: [{ soldAt: 'desc' }, { reference: 'desc' }],
            take,
            skip,
        });
    }

    async findById(id: string): Promise<SaleView | null> {
        const rows = await this.loadRows({ id });
        return rows.length === 0 ? null : (await this.hydrate(rows))[0];
    }

    async list(filter: SaleListFilter): Promise<SaleView[]> {
        const rows = await this.loadRows({ branchId: filter.branchId, businessDate: new Date(`${filter.businessDate}T00:00:00.000Z`) }, filter.limit, filter.offset);
        return this.hydrate(rows);
    }
}
