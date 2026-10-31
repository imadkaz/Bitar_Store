export interface AuditEventView {
    id: string;
    occurredAt: Date;
    action: string;
    entityType: string;
    entityId: string | null;
    branchId: string | null;
    actorId: string;
    actorName: string | null;
    details: Record<string, unknown>;
}

export interface AuditFilter {
    entityType?: string;
    entityId?: string;
    actorId?: string;
    branchId?: string;
    from?: string;      // shop day, YYYY-MM-DD
    to?: string;
    limit: number;
    offset: number;
}

export interface IAuditRepository {
    list(filter: AuditFilter): Promise<AuditEventView[]>;
}
