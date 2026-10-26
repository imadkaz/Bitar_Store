// src/repositories/UserRepository.ts
import { Prisma, PrismaClient } from '../generated/prisma/client';
import { UserMapper } from '../mapper/User.Mapper';
import { User } from '../models/User.model';
import { ConflictError } from '../utils/exeptions/ConflictError';
import { NotFoundError } from '../utils/exeptions/NotFoundError';
import { IUserRepository } from './interfaces/IUserRepository';

export class UserRepository implements IUserRepository {
    constructor(private readonly prisma: PrismaClient) { }
    
    async findById(id: string): Promise<User | null> {
        const raw = await this.prisma.user.findUnique({ where: { id } });
        return raw ? UserMapper.toDomain(raw) : null;
    }

    async findByEmail(email: string): Promise<User | null> {
        const raw = await this.prisma.user.findFirst({ where: { email } });
        return raw ? UserMapper.toDomain(raw) : null;
    }
    
    async list(): Promise<User[]> {
        const rows = await this.prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
        return rows.map(UserMapper.toDomain);
    }
    
    async create(user: User, actorId: string | null): Promise<User> {
        try {
            const raw = await this.prisma.user.create({ data: UserMapper.toPersistence(user, actorId) });
            return UserMapper.toDomain(raw);
        } catch (error) {
            throw this.translate(error);
        }
    }
    
    async update(user: User, actorId: string | null): Promise<User> {
        try {
            const raw = await this.prisma.user.update({
                where: { id: user.getId() },
                data: UserMapper.toUpdateData(user, actorId),
            });
            return UserMapper.toDomain(raw);
        } catch (error) {
            throw this.translate(error);
        }
    }
    async delete(id: string, _actorId: string | null): Promise<void> {
        try {
            await this.prisma.$transaction([
                this.prisma.userBranchAccess.deleteMany({ where: { userId: id } }),
                this.prisma.userPermissionOverride.deleteMany({ where: { userId: id } }),
                this.prisma.user.delete({ where: { id } }),
            ]);
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError) {
                if (error.code === 'P2003') {
                    throw new ConflictError('This user has history (other records point at them) and cannot be deleted. Deactivate the user instead.');
                }
                if (error.code === 'P2025') throw new NotFoundError('User not found');
            }
            throw error;
        }
    }

    // two requests can pass the "email is free" check at once; the unique index decides
    private translate(error: unknown): unknown {
        if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            (error as Prisma.PrismaClientKnownRequestError).code === 'P2002'
        ) {
            return new ConflictError('A user with this email already exists');
        }
        return error;
    }
}