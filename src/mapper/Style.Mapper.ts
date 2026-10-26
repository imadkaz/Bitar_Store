import { Prisma, Style as PrismaStyle } from '../generated/prisma/client';
import { Style } from '../models/Style.model';

export class StyleMapper {
    static toDomain(raw: PrismaStyle): Style {
        return Style.create({
            id: raw.id,
            code: raw.code,
            name: raw.name,
            category: raw.category,
            isActive: raw.isActive,
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt,
        });
    }

    static toPersistence(style: Style, actorId: string | null): Prisma.StyleUncheckedCreateInput {
        return {
            id: style.getId(),
            code: style.getCode(),
            name: style.getName(),
            category: style.getCategory(),
            isActive: style.isActive(),
            createdBy: actorId,
            updatedBy: actorId,
        };
    }

    // the code never changes after creation
    static toUpdateData(style: Style, actorId: string | null): Prisma.StyleUncheckedUpdateInput {
        return { name: style.getName(), category: style.getCategory(), isActive: style.isActive(), updatedBy: actorId };
    }
}
