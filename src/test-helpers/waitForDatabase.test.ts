import { describe, expect, it, vi } from 'vitest';
import { waitForDatabase } from './waitForDatabase';

describe('waitForDatabase', () => {
    it('returns at once when the database answers', async () => {
        const prisma = { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) };
        await waitForDatabase(prisma, 3, 1);
        expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('keeps trying while the database wakes up, then succeeds', async () => {
        const prisma = {
            $queryRaw: vi.fn()
                .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
                .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
                .mockResolvedValue([{ '?column?': 1 }]),
        };
        await waitForDatabase(prisma, 5, 1);
        expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    });

    it('gives up with the real error when it never answers', async () => {
        const prisma = { $queryRaw: vi.fn().mockRejectedValue(new Error('still asleep')) };
        await expect(waitForDatabase(prisma, 3, 1)).rejects.toThrow('still asleep');
        expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    });
});
