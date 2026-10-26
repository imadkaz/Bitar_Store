import { Style } from '../../models/Style.model';

export interface StyleFilter {
    search?: string;        // matches the code or the name, ignoring case
    activeOnly: boolean;
    limit: number;
    offset: number;
}

export interface IStyleRepository {
    findById(id: string): Promise<Style | null>;
    findByCode(code: string): Promise<Style | null>;
    list(filter: StyleFilter): Promise<Style[]>;
    save(style: Style, actorId: string | null): Promise<Style>;
    update(style: Style, actorId: string | null): Promise<Style>;
}
