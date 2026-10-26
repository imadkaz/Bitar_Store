import { Prisma, PrismaClient } from '../generated/prisma/client';
import { StyleMapper } from '../mapper/Style.Mapper';
import { Style } from '../models/Style.model';
import { ConflictError } from '../utils/exeptions/ConflictError';
import { IStyleRepository, StyleFilter } from './interfaces/IStyleRepository';

export class StyleRepository implements IStyleRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async findById(id: string): Promise<Style | null> {
        const raw = await this.prisma.style.findUnique({ where: { id } });
        return raw ? StyleMapper.toDomain(raw) : null;
    }

    async findByCode(code: string): Promise<Style | null> {
        const raw = await this.prisma.style.findFirst({ where: { code } });
        return raw ? StyleMapper.toDomain(raw) : null;
    }

    async list(filter: StyleFilter): Promise<Style[]> {
        const rows = await this.prisma.style.findMany({
            where: {
                ...(filter.activeOnly ? { isActive: true } : {}),
                ...(filter.search
                    ? {
                          OR: [
                              { name: { contains: filter.search, mode: 'insensitive' } },
                              { code: { contains: filter.search, mode: 'insensitive' } },
                          ],
                      }
                    : {}),
            },
            orderBy: [{ name: 'asc' }, { code: 'asc' }],
            take: filter.limit,
            skip: filter.offset,
        });
        return rows.map(StyleMapper.toDomain);
    }

    async save(style: Style, actorId: string): Promise<Style> {
        try {
            const raw = await this.prisma.style.create({ data: StyleMapper.toPersistence(style, actorId) });
            return StyleMapper.toDomain(raw);
        } catch (error) {
            // two requests can pass the "code is free" check at once: the unique index has the last word
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                throw new ConflictError('A style with this code already exists');
            }
            throw error;
        }
    }

    async update(style: Style, actorId: string): Promise<Style> {
        const raw = await this.prisma.style.update({
            where: { id: style.getId() },
            data: StyleMapper.toUpdateData(style, actorId),
        });
        return StyleMapper.toDomain(raw);
    }
}
