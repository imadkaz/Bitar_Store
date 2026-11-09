import { PrismaClient } from '../generated/prisma/client';
import { DEFAULT_SETTINGS, Settings } from '../models/Settings.model';
import { writeAudit } from './audit';

export interface ISettingsRepository {
    get(): Promise<Settings>;
    update(changes: Partial<Settings>, actorId: string): Promise<Settings>;
}

export class SettingsRepository implements ISettingsRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async get(): Promise<Settings> {
        const rows = await this.prisma.$queryRaw<{ key: string; value: unknown }[]>`SELECT key, value FROM settings`;
        const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
        return { ...DEFAULT_SETTINGS, ...stored } as Settings;
    }

    async update(changes: Partial<Settings>, actorId: string): Promise<Settings> {
        await this.prisma.$transaction(async (tx) => {
            const before = await tx.$queryRaw<{ key: string; value: unknown }[]>`SELECT key, value FROM settings WHERE key = ANY(${Object.keys(changes)}::text[]) FOR UPDATE`;
            const was = new Map(before.map((r) => [r.key, r.value]));
            const done: { setting: string; before: unknown; after: unknown }[] = [];
            for (const [key, value] of Object.entries(changes)) {
                const previous = was.has(key) ? was.get(key) : (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key];
                if (JSON.stringify(previous) === JSON.stringify(value)) continue;
                await tx.$executeRaw`
                    INSERT INTO settings (key, value, updated_by, updated_at) VALUES (${key}, ${JSON.stringify(value)}::jsonb, ${actorId}::uuid, now())
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
                done.push({ setting: key, before: previous, after: value });
            }
            if (done.length > 0) await writeAudit(tx, { actorId, action: 'settings.update', entityType: 'settings', entityId: actorId, details: { changed: done } });
        });
        return this.get();
    }
}
