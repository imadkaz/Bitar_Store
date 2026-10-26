import { Style } from '../../models/Style.model';
import { IStyleRepository } from '../../repositories/interfaces/IStyleRepository';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';

export interface UpdateStyleInput {
    id: string;
    name?: string ;         
    category?: string;      // null or "" clears the category
    isActive?: boolean;
}

// Single style: mutate the loaded entity, then save it. The style code never changes.
export class UpdateStyleUsecase {
    constructor(private readonly styleRepository: IStyleRepository) {}

    async execute(input: UpdateStyleInput, actorId: string): Promise<Style> {
        const style = await this.styleRepository.findById(input.id);
        if (!style) throw new NotFoundError('Style not found');

        if (input.name !== undefined) style.rename(input.name);
        if (input.category !== undefined) style.changeCategory(input.category);
        if (input.isActive !== undefined) {
            if (typeof input.isActive !== 'boolean') throw new ValidationError('isActive must be true or false');
            if (input.isActive) style.activate();
            else style.deactivate();
        }
        return this.styleRepository.update(style, actorId);
    }
}
