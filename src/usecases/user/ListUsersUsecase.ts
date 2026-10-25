import { User } from '../../models/User.model';
import { IUserRepository } from '../../repositories/interfaces/IUserRepository';

export class ListUsersUsecase {
    constructor(private readonly userRepository: IUserRepository) {}

    execute(): Promise<User[]> {
        return this.userRepository.list();
    }
}
