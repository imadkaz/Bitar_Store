import { Prisma } from '../generated/prisma/client';
import { ConflictError } from '../utils/exeptions/ConflictError';
import { IdempotencyClaim } from './interfaces/ISalesUnitOfWork';

type Tx = Prisma.TransactionClient;

// Claims an Idempotency-Key INSIDE the caller's transaction.
// - First request: the row is inserted (invisible to others until we commit) and we go ahead.
// - A second request with the same key at the same moment WAITS here (the unique index makes it wait for the first
//   one to commit or roll back). If the first committed, we find its row and replay its result. If it rolled back,
//   we insert the row ourselves and do the work. So the work is done at most once.
export async function claimIdempotencyKey(tx: Tx, userId: string, operation: string, key: string, requestHash: string): Promise<IdempotencyClaim> {
    const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO idempotency_keys (user_id, operation, idempotency_key, request_hash)
        VALUES (${userId}::uuid, ${operation}, ${key}, ${requestHash})
        ON CONFLICT (user_id, operation, idempotency_key) DO NOTHING
        RETURNING id`;
    if (inserted.length === 1) return { kind: 'claimed', keyId: inserted[0].id };

    const existing = await tx.idempotencyKey.findFirst({ where: { userId, operation, key } });
    if (!existing) throw new ConflictError('Please try again');                    // it vanished between the two queries
    if (existing.requestHash !== requestHash) return { kind: 'different_request' };
    if (existing.completedAt && existing.resourceId) return { kind: 'replay', resourceId: existing.resourceId };
    return { kind: 'in_progress' };
}

export async function completeIdempotencyKey(tx: Tx, keyId: string, resourceType: string, resourceId: string): Promise<void> {
    await tx.idempotencyKey.update({
        where: { id: keyId },
        data: { responseStatus: 201, resourceType, resourceId, completedAt: new Date() },
    });
}
