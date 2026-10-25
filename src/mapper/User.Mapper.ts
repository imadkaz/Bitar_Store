// src/mapper/User.Mapper.ts  (ما شفتو، فهاد اللي لازم يطابق التصميم)
import { Prisma, User as PrismaUser } from '../generated/prisma/client';
import { User, UserRole } from '../models/User.model';

export class UserMapper {
    static toDomain(raw: PrismaUser): User {
        return User.create({
            id: raw.id,
            email: raw.email,
            passwordHash: raw.passwordHash,
            fullName: raw.fullName,
            role: raw.role as UserRole,
            isActive: raw.isActive,
            deactivatedAt: raw.deactivatedAt,
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt,
        });
    }

    // version and updated_at are maintained by the database trigger, never written from here
    static toPersistence(user: User, actorId: string | null): Prisma.UserUncheckedCreateInput {
        return {
            id: user.getId(),
            email: user.getEmail(),
            passwordHash: user.getPasswordHash(),
            fullName: user.getFullName(),
            role: user.getRole(),
            isActive: user.isActive(),
            deactivatedAt: user.getDeactivatedAt(),
            createdBy: actorId,
            updatedBy: actorId,
        };
    }

    static toUpdateData(user: User, actorId: string | null): Prisma.UserUncheckedUpdateInput {
        return {
            email: user.getEmail(),
            passwordHash: user.getPasswordHash(),
            fullName: user.getFullName(),
            role: user.getRole(),
            isActive: user.isActive(),
            deactivatedAt: user.getDeactivatedAt(),
            updatedBy: actorId,
        };
    }
}