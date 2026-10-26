import { describe, expect, it } from 'vitest';
import { makeCatalog, makeStyle } from '../../test-helpers/catalogFakes';
import { ConflictError } from '../../utils/exeptions/ConflictError';
import { NotFoundError } from '../../utils/exeptions/NotFoundError';
import { ValidationError } from '../../utils/exeptions/ValidationError';
import { CreateStyleUsecase } from '../styles/CreateStyleUsecase';
import { GetStyleUsecase } from '../styles/GetStyleUsecase';
import { ListStylesUsecase } from '../styles/ListStylesUsecase';
import { UpdateStyleUsecase } from '../styles/UpdateStyleUsecase';

describe('CreateStyleUsecase', () => {
    it('stores the code upper case, trims the name and the category, and remembers who created it', async () => {
        const { styles } = makeCatalog();
        const style = await new CreateStyleUsecase(styles).execute({ code: ' nk-100 ', name: '  Club Tee ', category: ' Tops ' }, 'manager-1');
        expect(style).toMatchObject({});
        expect(style.getCode()).toBe('NK-100');
        expect(style.getName()).toBe('Club Tee');
        expect(style.getCategory()).toBe('Tops');
        expect(styles.audit.get(style.getId())?.createdBy).toBe('manager-1');
    });

    it('refuses a duplicate code in any letter case', async () => {
        const { styles } = makeCatalog();
        const useCase = new CreateStyleUsecase(styles);
        await useCase.execute({ code: 'NK-100', name: 'A' }, 'm');
        await expect(useCase.execute({ code: 'nk-100', name: 'B' }, 'm')).rejects.toBeInstanceOf(ConflictError);
    });

    it('turns every bad input into a ValidationError (400), never a crash (500)', async () => {
        const { styles } = makeCatalog();
        const useCase = new CreateStyleUsecase(styles);
        for (const input of [{ code: undefined, name: 'A' }, { code: 'ok', name: undefined }, { code: 'has space', name: 'A' }, { code: 'ok', name: ' ' }, { code: 'ok', name: 'A', category: 5 }, { code: 5, name: 'A' }]) {
            await expect(useCase.execute(input as never, 'm')).rejects.toBeInstanceOf(ValidationError);
        }
    });
});

describe('UpdateStyleUsecase', () => {
    it('SAVES the changes: the stored style is what changed', async () => {
        const { styles } = makeCatalog();
        const style = makeStyle({ category: 'Tops' });
        await styles.save(style, 'creator');
        await new UpdateStyleUsecase(styles).execute({ id: style.getId(), name: 'Renamed', category: 'shoes', isActive: false }, 'editor');
        const stored = (await styles.findById(style.getId()))!;
        expect(stored.getName()).toBe('Renamed');
        expect(stored.getCategory()).toBe('shoes');
        expect(stored.isActive()).toBe(false);
        expect(stored.getCode()).toBe(style.getCode());
        expect(styles.audit.get(style.getId())).toEqual({ createdBy: 'creator', updatedBy: 'editor' });
    });

    it('404 for an unknown style, 400 for a bad value, and a bad update changes nothing', async () => {
        const { styles } = makeCatalog();
        const style = makeStyle({ name: 'Original' });
        await styles.save(style, 'c');
        const useCase = new UpdateStyleUsecase(styles);
        await expect(useCase.execute({ id: 'nobody', name: 'X' }, 'e')).rejects.toBeInstanceOf(NotFoundError);
        await expect(useCase.execute({ id: style.getId(), isActive: 'yes' as never }, 'e')).rejects.toBeInstanceOf(ValidationError);
        await expect(useCase.execute({ id: style.getId(), name: 'Changed', category: 'C'.repeat(61) }, 'e')).rejects.toBeInstanceOf(ValidationError);
        expect((await styles.findById(style.getId()))?.getName()).toBe('Original');
    });
});

describe('ListStylesUsecase and GetStyleUsecase', () => {
    it('searches by name or code, can hide inactive ones, and pages (default 50, at most 200)', async () => {
        const { styles } = makeCatalog();
        const inactive = makeStyle({ name: 'Hoodie Old', code: 'H-1', isActive: false });
        for (const s of [makeStyle({ name: 'Hoodie New', code: 'H-2' }), inactive, makeStyle({ name: 'Tee', code: 'T-1' })]) await styles.save(s, 'c');
        const useCase = new ListStylesUsecase(styles);
        expect((await useCase.execute({ search: 'hoodie' })).map((s) => s.getCode())).toEqual(['H-2', 'H-1']);       // sorted by name
        expect((await useCase.execute({ search: 'hoodie', activeOnly: true })).map((s) => s.getCode())).toEqual(['H-2']);
        expect((await useCase.execute({ search: 't-1' })).map((s) => s.getCode())).toEqual(['T-1']);
        expect((await useCase.execute({ limit: 1, offset: 1 })).map((s) => s.getCode())).toEqual(['H-1']);
        for (const bad of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { offset: -1 }, { search: 'x'.repeat(101) }]) {
            await expect(useCase.execute(bad)).rejects.toBeInstanceOf(ValidationError);
        }
    });

    it('GetStyle returns the style with its skus, or 404', async () => {
        const { styles, skus } = makeCatalog();
        const style = makeStyle();
        await styles.save(style, 'c');
        const { makeSku } = await import('../../test-helpers/catalogFakes');
        await skus.save(makeSku(style.getId(), { size: 'S' }), 'c');
        await skus.save(makeSku(style.getId(), { size: 'L' }), 'c');
        const result = await new GetStyleUsecase(styles, skus).execute(style.getId());
        expect(result.skus).toHaveLength(2);
        await expect(new GetStyleUsecase(styles, skus).execute('nobody')).rejects.toBeInstanceOf(NotFoundError);
    });
});
