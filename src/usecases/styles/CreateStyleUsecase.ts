import { randomUUID } from 'node:crypto';
import { Style, normalizeStyleCode } from '../../models/Style.model';
import { IStyleRepository } from '../../repositories/interfaces/IStyleRepository';
import { ConflictError } from '../../utils/exeptions/ConflictError';

export interface CreateStyleInput {
    code: string;
    name: string;
    category?: string | null;
}

export class CreateStyleUsecase {
    constructor(private readonly styleRepository: IStyleRepository) {}

    async execute(input: CreateStyleInput, actorId: string): Promise<Style> {
        const code = normalizeStyleCode(input.code);
        if (await this.styleRepository.findByCode(code)) {
            throw new ConflictError('A style with this code already exists');
        }
        const style = Style.create({
            id: randomUUID(), 
            code, 
            name: input.name as string, 
            category: input.category as string | null | undefined 
        });
        return this.styleRepository.save(style, actorId);
    }
}
