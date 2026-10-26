// src/repositories/interfaces/IUserRepository.ts
import { User } from '../../models/User.model';

export interface IUserRepository {
    findById(id: string): Promise<User | null>;
    findByEmail(email: string): Promise<User | null>;
    list(): Promise<User[]>;
    create(user: User, actorId: string | null): Promise<User>;
    update(user: User, actorId: string | null): Promise<User>;
    delete(id: string, actorId: string | null): Promise<void>;
}