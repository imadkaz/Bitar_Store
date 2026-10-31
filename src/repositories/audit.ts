import { Prisma } from '../generated/prisma/client';

export interface AuditInput {
    actorId: string;
    action: string;          // "entity.verb"
    entityType: string;
    entityId?: string | null;
    branchId?: string | null;
    details?: Record<string, unknown>;
}

// Writes an audit event INSIDE the caller's transaction, so a change and its record stand or fall together.
export async function writeAudit(tx: Prisma.TransactionClient, event: AuditInput): Promise<void> {
    await tx.auditEvent.create({
        data: {
            actorUserId: event.actorId,
            action: event.action,
            entityType: event.entityType,
            entityId: event.entityId ?? null,
            branchId: event.branchId ?? null,
            details: (event.details ?? {}) as Prisma.InputJsonValue,
        },
    });
}

// "%" and "_" typed by the user must search for themselves, not act as wildcards
export function likePattern(search: string): string {
    return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
