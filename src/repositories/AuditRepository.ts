import { Prisma, PrismaClient } from '../generated/prisma/client';
import { BUSINESS_TIME_ZONE } from '../utils/businessDate';
import { AuditEventView, AuditFilter, IAuditRepository } from './interfaces/IAuditRepository';

export class AuditRepository implements IAuditRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async list(filter: AuditFilter): Promise<AuditEventView[]> {
        const entityType = filter.entityType ? Prisma.sql`AND e.entity_type = ${filter.entityType}` : Prisma.empty;
        const entityId = filter.entityId ? Prisma.sql`AND e.entity_id = ${filter.entityId}::uuid` : Prisma.empty;
        const actor = filter.actorId ? Prisma.sql`AND e.actor_user_id = ${filter.actorId}::uuid` : Prisma.empty;
        const branch = filter.branchId ? Prisma.sql`AND e.branch_id = ${filter.branchId}::uuid` : Prisma.empty;
        const from = filter.from ? Prisma.sql`AND e.occurred_at >= (${filter.from}::date)::timestamp AT TIME ZONE ${BUSINESS_TIME_ZONE}` : Prisma.empty;
        const to = filter.to ? Prisma.sql`AND e.occurred_at < ((${filter.to}::date + 1))::timestamp AT TIME ZONE ${BUSINESS_TIME_ZONE}` : Prisma.empty;
        const rows = await this.prisma.$queryRaw<{
            id: string; occurred_at: Date; action: string; entity_type: string; entity_id: string | null; branch_id: string | null;
            actor_user_id: string; actor_name: string | null; details: Record<string, unknown>;
        }[]>(Prisma.sql`
            SELECT e.id, e.occurred_at, e.action, e.entity_type, e.entity_id, e.branch_id, e.actor_user_id, u.full_name AS actor_name, e.details
            FROM audit_events e
            LEFT JOIN users u ON u.id = e.actor_user_id
            WHERE TRUE ${entityType} ${entityId} ${actor} ${branch} ${from} ${to}
            ORDER BY e.occurred_at DESC, e.id DESC
            LIMIT ${filter.limit} OFFSET ${filter.offset}`);
        return rows.map((r) => ({
            id: r.id, occurredAt: r.occurred_at, action: r.action, entityType: r.entity_type, entityId: r.entity_id, branchId: r.branch_id,
            actorId: r.actor_user_id, actorName: r.actor_name, details: r.details,
        }));
    }
}
