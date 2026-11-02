import { ValidationError } from '../utils/exeptions/ValidationError';

export const MAX_CATEGORY_NAME = 60;

// A category is a name the owner manages: "Dresses", "Accessories". Same rules as the database CHECK (no spaces around, 1 to 60).
export function normalizeCategoryName(value: unknown): string {
    if (typeof value !== 'string') throw new ValidationError('Category name is required');
    const name = value.trim().replace(/\s+/g, ' ');
    if (name.length < 1 || name.length > MAX_CATEGORY_NAME) throw new ValidationError(`Category name must be 1 to ${MAX_CATEGORY_NAME} characters`);
    if (/[\u0000-\u001f\u007f]/.test(name)) throw new ValidationError('Category name has invalid characters');
    return name;
}
