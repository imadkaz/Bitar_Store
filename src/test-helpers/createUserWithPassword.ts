import { User, UserRole } from '../models/User.model';
import { IUserRepository } from '../repositories/interfaces/IUserRepository';
import { CreateUserUsecase } from '../usecases/user/CreateUserUsecase';
import { SetUserPasswordUsecase } from '../usecases/user/SetUserPasswordUsecase';

// Integration tests need users who CAN log in: create the user, then set the password, exactly like the admin does.
export async function createUserWithPassword(
    repo: IUserRepository,
    input: { email: string; fullName: string; role: UserRole; password: string },
    actorId: string | null,
): Promise<User> {
    const user = await new CreateUserUsecase(repo).execute({ email: input.email, fullName: input.fullName, role: input.role }, actorId);
    await new SetUserPasswordUsecase(repo).execute(user.getId(), input.password, actorId);
    return user;
}
