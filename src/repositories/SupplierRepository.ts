import { Prisma, PrismaClient } from '../generated/prisma/client';
import { CreateSupplierRequest, UpdateSupplierRequest } from '../models/Supplier.model';
import { ConflictError } from '../utils/exeptions/ConflictError';
import { NotFoundError } from '../utils/exeptions/NotFoundError';
import { writeAudit } from './audit';
import { ISupplierRepository, SupplierListFilter, SupplierView } from './interfaces/ISupplierRepository';

interface Row { id: string; name: string; phone: string | null; note: string | null; is_active: boolean; receipt_count: number; created_at: Date; updated_at: Date }

const SELECT = Prisma.sql`
    SELECT s.id, s.name, s.phone, s.note, s.is_active, s.created_at, s.updated_at,
           (SELECT COUNT(*)::int FROM goods_receipts r WHERE r.supplier_id = s.id) AS receipt_count
    FROM suppliers s`;
const toView = (r: Row): SupplierView => ({ id: r.id, name: r.name, phone: r.phone, note: r.note, isActive: r.is_active, receiptCount: r.receipt_count, createdAt: r.created_at, updatedAt: r.updated_at });
const isUnique = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

export class SupplierRepository implements ISupplierRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async findById(id: string): Promise<SupplierView | null> {
        const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`${SELECT} WHERE s.id = ${id}::uuid`);
        return rows[0] ? toView(rows[0]) : null;
    }

    async list(filter: SupplierListFilter): Promise<{ items: SupplierView[]; total: number }> {
        const like = filter.search ? `%${filter.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
        const search = like ? Prisma.sql`AND (s.name ILIKE ${like} OR s.phone ILIKE ${like})` : Prisma.empty;
        const active = filter.active === undefined ? Prisma.empty : Prisma.sql`AND s.is_active = ${filter.active}`;
        const where = Prisma.sql`TRUE ${search} ${active}`;
        const [rows, count] = await Promise.all([
            this.prisma.$queryRaw<Row[]>(Prisma.sql`${SELECT} WHERE ${where} ORDER BY lower(s.name), s.id LIMIT ${filter.limit} OFFSET ${filter.offset}`),
            this.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS n FROM suppliers s WHERE ${where}`),
        ]);
        return { items: rows.map(toView), total: count[0].n };
    }

    async create(request: CreateSupplierRequest, actorId: string): Promise<SupplierView> {
        try {
            const id = await this.prisma.$transaction(async (tx) => {
                const row = await tx.supplier.create({ data: { name: request.name, phone: request.phone, note: request.note, createdBy: actorId, updatedBy: actorId } });
                await writeAudit(tx, { actorId, action: 'supplier.create', entityType: 'supplier', entityId: row.id, details: { name: row.name } });
                return row.id;
            });
            return (await this.findById(id))!;
        } catch (error) {
            if (isUnique(error)) throw new ConflictError('A supplier with this name already exists');
            throw error;
        }
    }

    async update(id: string, request: UpdateSupplierRequest, actorId: string): Promise<SupplierView> {
        try {
            await this.prisma.$transaction(async (tx) => {
                const before = await tx.supplier.findUnique({ where: { id } });
                if (!before) throw new NotFoundError('Supplier not found');
                await tx.supplier.update({ where: { id }, data: { ...request, updatedBy: actorId, updatedAt: new Date() } });
                const changed = Object.entries(request).filter(([k, v]) => (before as Record<string, unknown>)[k] !== v).map(([k, v]) => ({ field: k, before: (before as Record<string, unknown>)[k], after: v }));
                await writeAudit(tx, { actorId, action: 'supplier.update', entityType: 'supplier', entityId: id, details: { changed } });
            });
            return (await this.findById(id))!;
        } catch (error) {
            if (isUnique(error)) throw new ConflictError('A supplier with this name already exists');
            throw error;
        }
    }
}
