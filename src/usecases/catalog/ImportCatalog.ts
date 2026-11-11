import { parseMoneyToCents } from '../../models/Money';
import { normalizeSkuCode, validateColor, validateSize } from '../../models/Sku.model';
import { normalizeStyleCode, validateCategory, validateStyleName } from '../../models/Style.model';

// Importing a catalog from a file (the SKU sheet of the owners). Pure: no database here. The rules are the ones of the app itself (the same validators the API uses).
export interface ImportRow { line: number; modelCode: string; productName: string; category: string; sku: string; color: string; size: string; unitCost: string | null; sellPrice: string | null; material: string }
export interface RowIssue { line: number; sku: string; reason: string }
export interface PlannedSku { line: number; styleCode: string; skuCode: string; size: string; color: string; priceCents: number; costCents: number | null }
export interface PlannedStyle { code: string; name: string; category: string | null; skus: number }
export interface ImportPlan {
    styles: PlannedStyle[];             // the styles with at least one sku to import (existing ones are reused, never changed)
    skus: PlannedSku[];                 // to create
    existingStyles: string[];           // already in the database: reused
    existingSkus: string[];             // already in the database: skipped
    withoutPrice: RowIssue[];           // no selling price in the file: NOT imported (a product is never sold at an invented price)
    invalid: RowIssue[];                // refused by the rules of the app: nothing of the file is written while there are some
    warnings: string[];
}

// RFC 4180: quoted fields with commas, doubled quotes, CRLF, and the BOM Excel may add
export function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [], field = '', quoted = false;
    const source = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < source.length; i++) {
        const c = source[i];
        if (quoted) {
            if (c === '"' && source[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && source[i + 1] === '\n') i++;
            row.push(field); field = '';
            if (row.some((x) => x.trim() !== '')) rows.push(row);
            row = [];
        } else field += c;
    }
    row.push(field);
    if (row.some((x) => x.trim() !== '')) rows.push(row);
    return rows;
}

const COLUMNS = ['model_code', 'product_name', 'category', 'sku', 'color', 'size', 'unit_cost_usd_est', 'sell_price_usd', 'material_as_written'] as const;

export function readRows(text: string): { rows: ImportRow[]; problems: string[] } {
    const table = parseCsv(text);
    if (table.length === 0) return { rows: [], problems: ['The file is empty'] };
    const header = table[0].map((h) => h.trim().toLowerCase());
    const missing = COLUMNS.filter((c) => !header.includes(c));
    if (missing.length > 0) return { rows: [], problems: [`The file has no column: ${missing.join(', ')}`] };
    const at = (row: string[], name: (typeof COLUMNS)[number]) => (row[header.indexOf(name)] ?? '').trim();
    const rows = table.slice(1).map((row, i): ImportRow => ({
        line: i + 2, modelCode: at(row, 'model_code'), productName: at(row, 'product_name'), category: at(row, 'category'), sku: at(row, 'sku'), color: at(row, 'color'), size: at(row, 'size'),
        unitCost: at(row, 'unit_cost_usd_est') || null, sellPrice: at(row, 'sell_price_usd') || null, material: at(row, 'material_as_written'),
    }));
    return { rows, problems: [] };
}

export function planImport(rows: ImportRow[], existingStyleCodes: Set<string>, existingSkuCodes: Set<string>): ImportPlan {
    const plan: ImportPlan = { styles: [], skus: [], existingStyles: [], existingSkus: [], withoutPrice: [], invalid: [], warnings: [] };
    const attempt = <T,>(row: ImportRow, run: () => T): T | null => {
        try { return run(); } catch (error) { plan.invalid.push({ line: row.line, sku: row.sku || '(no sku)', reason: error instanceof Error ? error.message : 'invalid' }); return null; }
    };
    const styleOf = new Map<string, { name: string; category: string | null; firstLine: number }>();
    const seenSkus = new Map<string, number>();
    const planned: PlannedSku[] = [];
    for (const row of rows) {
        const styleCode = attempt(row, () => normalizeStyleCode(row.modelCode));
        const name = attempt(row, () => validateStyleName(row.productName));
        const category = attempt(row, () => validateCategory(row.category));
        const skuCode = attempt(row, () => normalizeSkuCode(row.sku));
        const size = attempt(row, () => validateSize(row.size));
        const color = attempt(row, () => validateColor(row.color));
        if (styleCode === null || name === null || skuCode === null || size === null || color === null || (row.category !== '' && category === null && row.category.trim() !== '')) continue;
        // the rows of one model must agree on its name and category
        const known = styleOf.get(styleCode);
        if (!known) styleOf.set(styleCode, { name, category, firstLine: row.line });
        else if (known.name !== name || known.category !== category) { plan.invalid.push({ line: row.line, sku: skuCode, reason: `${styleCode} is "${known.name}" / ${known.category ?? 'no category'} on line ${known.firstLine} but "${name}" / ${category ?? 'no category'} here` }); continue; }
        const duplicate = seenSkus.get(skuCode);
        if (duplicate !== undefined) { plan.invalid.push({ line: row.line, sku: skuCode, reason: `the sku code is already on line ${duplicate}` }); continue; }
        seenSkus.set(skuCode, row.line);
        if (row.sellPrice === null) { plan.withoutPrice.push({ line: row.line, sku: skuCode, reason: 'no selling price in the file' }); continue; }
        const priceCents = attempt(row, () => parseMoneyToCents(row.sellPrice as string, 'Sell price'));
        if (priceCents === null) continue;
        if (priceCents <= 0) { plan.invalid.push({ line: row.line, sku: skuCode, reason: 'the selling price must be more than zero' }); continue; }
        let costCents: number | null = null;
        if (row.unitCost !== null) {
            costCents = attempt(row, () => parseMoneyToCents(row.unitCost as string, 'Unit cost'));
            if (costCents === null) continue;
            if (costCents > priceCents) plan.warnings.push(`line ${row.line} (${skuCode}): the cost ${row.unitCost} is above the price ${row.sellPrice}`);
        }
        planned.push({ line: row.line, styleCode, skuCode, size, color, priceCents, costCents });
    }
    for (const sku of planned) {
        if (existingSkuCodes.has(sku.skuCode)) plan.existingSkus.push(sku.skuCode); else plan.skus.push(sku);
    }
    const counts = new Map<string, number>();
    for (const sku of plan.skus) counts.set(sku.styleCode, (counts.get(sku.styleCode) ?? 0) + 1);
    for (const [code, skus] of counts) {
        if (existingStyleCodes.has(code)) plan.existingStyles.push(code);
        else plan.styles.push({ code, name: styleOf.get(code)!.name, category: styleOf.get(code)!.category, skus });
    }
    for (const code of [...new Set(planned.map((s) => s.styleCode))]) if (existingStyleCodes.has(code) && !plan.existingStyles.includes(code) && !counts.has(code)) plan.existingStyles.push(code);
    return plan;
}
