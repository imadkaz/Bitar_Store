import { AuthContext } from '../../models/AuthContext';
import { parseSettingsUpdate, Settings } from '../../models/Settings.model';
import { UserRole } from '../../models/User.model';
import { ISettingsRepository } from '../../repositories/SettingsRepository';
import { ForbiddenError } from '../../utils/exeptions/ForbiddenError';

// everyone signed in reads them (the till needs the exchange rate); an admin or a manager changes them
export class GetSettingsUsecase {
    constructor(private readonly settings: ISettingsRepository) {}
    async execute(): Promise<Settings> { return this.settings.get(); }
}

export class UpdateSettingsUsecase {
    constructor(private readonly settings: ISettingsRepository) {}
    async execute(body: unknown, auth: AuthContext): Promise<Settings> {
        const role = auth.user.getRole();
        if (role !== UserRole.ADMIN && role !== UserRole.MANAGER) throw new ForbiddenError('Only an admin or a manager can change the settings');
        return this.settings.update(parseSettingsUpdate(body), auth.user.getId());
    }
}
