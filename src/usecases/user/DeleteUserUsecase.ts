import { IUserRepository } from "../../repositories/interfaces/IUserRepository";

export class DeleteUserUsecase {
    constructor(private readonly userRepository: IUserRepository) { }

    async execute(userId: string): Promise<void> {
        await this.userRepository.delete(userId);
    }
}