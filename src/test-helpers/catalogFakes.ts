import { randomUUID } from 'node:crypto';
import { Barcode } from '../models/Barcode.model';
import { PriceChange, Sku, SkuProps } from '../models/Sku.model';
import { Style, StyleProps } from '../models/Style.model';
import { IBarcodeRepository } from '../repositories/interfaces/IBarcodeRepository';
import { ISkuRepository, SkuFilter, SkuWithStyle } from '../repositories/interfaces/ISkuRepository';
import { IStyleRepository, StyleFilter } from '../repositories/interfaces/IStyleRepository';
import { ConflictError } from '../utils/exeptions/ConflictError';

// Pretend catalog tables in memory, for use-case tests (see fakes.ts for why every read and write COPIES the entity).

const copyStyle = (s: Style): Style =>
    Style.create({ id: s.getId(), code: s.getCode(), name: s.getName(), category: s.getCategory(), isActive: s.isActive(), createdAt: s.getCreatedAt(), updatedAt: s.getUpdatedAt() });

const copySku = (s: Sku): Sku =>
    Sku.create({
        id: s.getId(), styleId: s.getStyleId(), skuCode: s.getSkuCode(), size: s.getSize(), color: s.getColor(),
        standardPriceCents: s.getStandardPriceCents(), currency: s.getCurrency(), isActive: s.isActive(), createdAt: s.getCreatedAt(), updatedAt: s.getUpdatedAt(),
    });

const copyBarcode = (b: Barcode): Barcode => Barcode.create({ id: b.getId(), skuId: b.getSkuId(), code: b.getCode(), createdAt: b.getCreatedAt() });

export class FakeStyleRepository implements IStyleRepository {
    readonly items = new Map<string, Style>();
    readonly audit = new Map<string, { createdBy: string | null; updatedBy: string | null }>();

    constructor(seed: Style[] = []) {
        seed.forEach((s) => this.items.set(s.getId(), copyStyle(s)));
    }

    async findById(id: string) {
        const found = this.items.get(id);
        return found ? copyStyle(found) : null;
    }

    async findByCode(code: string) {
        const found = [...this.items.values()].find((s) => s.getCode() === code);
        return found ? copyStyle(found) : null;
    }

    async list(filter: StyleFilter) {
        const q = filter.search?.toLowerCase();
        return [...this.items.values()]
            .filter((s) => (!filter.activeOnly || s.isActive()) && (!q || s.getName().toLowerCase().includes(q) || s.getCode().toLowerCase().includes(q)))
            .sort((a, b) => a.getName().localeCompare(b.getName()) || a.getCode().localeCompare(b.getCode()))
            .slice(filter.offset, filter.offset + filter.limit)
            .map(copyStyle);
    }

    async save(style: Style, actorId: string | null) {
        if (await this.findByCode(style.getCode())) throw new ConflictError('A style with this code already exists');
        this.items.set(style.getId(), copyStyle(style));
        this.audit.set(style.getId(), { createdBy: actorId, updatedBy: actorId });
        return copyStyle(style);
    }

    async update(style: Style, actorId: string | null) {
        this.items.set(style.getId(), copyStyle(style));
        this.audit.set(style.getId(), { createdBy: this.audit.get(style.getId())?.createdBy ?? null, updatedBy: actorId });
        return copyStyle(style);
    }
}

export class FakeBarcodeRepository implements IBarcodeRepository {
    readonly items = new Map<string, Barcode>();

    async findById(id: string) {
        const found = this.items.get(id);
        return found ? copyBarcode(found) : null;
    }

    async findByCode(code: string) {
        const found = [...this.items.values()].find((b) => b.getCode() === code);
        return found ? copyBarcode(found) : null;
    }

    async listBySku(skuId: string) {
        return [...this.items.values()].filter((b) => b.getSkuId() === skuId).map(copyBarcode);
    }

    async save(barcode: Barcode) {
        if (await this.findByCode(barcode.getCode())) throw new ConflictError('This barcode already belongs to a sku');
        this.items.set(barcode.getId(), copyBarcode(barcode));
        return copyBarcode(barcode);
    }

    async delete(id: string) {
        this.items.delete(id);
    }
}

export class FakeSkuRepository implements ISkuRepository {
    readonly items = new Map<string, Sku>();
    readonly history: PriceChange[] = [];                  // every price-history row ever written, oldest first
    readonly audit = new Map<string, { createdBy: string | null; updatedBy: string | null }>();

    constructor(private readonly styles: FakeStyleRepository, private readonly barcodes: FakeBarcodeRepository, seed: Sku[] = []) {
        seed.forEach((s) => this.items.set(s.getId(), copySku(s)));
    }

    private async withStyle(sku: Sku): Promise<SkuWithStyle> {
        return { sku: copySku(sku), style: (await this.styles.findById(sku.getStyleId()))! };
    }

    async findById(id: string) {
        const found = this.items.get(id);
        return found ? copySku(found) : null;
    }

    async findWithStyleById(id: string) {
        const found = this.items.get(id);
        return found ? this.withStyle(found) : null;
    }

    async findBySkuCode(code: string) {
        const found = [...this.items.values()].find((s) => s.getSkuCode() === code);
        return found ? copySku(found) : null;
    }

    async findByVariant(styleId: string, size: string, color: string, excludeId?: string) {
        const norm = (t: string) => t.trim().toLowerCase();
        const found = [...this.items.values()].find(
            (s) => s.getStyleId() === styleId && norm(s.getSize()) === norm(size) && norm(s.getColor()) === norm(color) && s.getId() !== excludeId,
        );
        return found ? copySku(found) : null;
    }

    async findByBarcode(code: string) {
        const barcode = await this.barcodes.findByCode(code);
        return barcode ? this.withStyle(this.items.get(barcode.getSkuId())!) : null;
    }

    async list(filter: SkuFilter) {
        const q = filter.search?.toLowerCase();
        const matches: SkuWithStyle[] = [];
        for (const sku of this.items.values()) {
            const style = (await this.styles.findById(sku.getStyleId()))!;
            const hit = !q || sku.getSkuCode().toLowerCase().includes(q) || sku.getColor().toLowerCase().includes(q) || style.getName().toLowerCase().includes(q);
            if (hit && (!filter.styleId || sku.getStyleId() === filter.styleId) && (!filter.activeOnly || sku.isActive())) matches.push({ sku: copySku(sku), style });
        }
        return matches.sort((a, b) => a.sku.getSkuCode().localeCompare(b.sku.getSkuCode())).slice(filter.offset, filter.offset + filter.limit);
    }

    async listByStyle(styleId: string) {
        return [...this.items.values()].filter((s) => s.getStyleId() === styleId).map(copySku);
    }

    async save(sku: Sku, actorId: string) {
        if (await this.findBySkuCode(sku.getSkuCode())) throw new ConflictError('A sku with this code already exists');
        if (await this.findByVariant(sku.getStyleId(), sku.getSize(), sku.getColor())) throw new ConflictError('This style already has a sku with the same size and color');
        this.items.set(sku.getId(), copySku(sku));
        this.audit.set(sku.getId(), { createdBy: actorId, updatedBy: actorId });
        this.history.push({ id: randomUUID(), skuId: sku.getId(), oldPriceCents: null, newPriceCents: sku.getStandardPriceCents(), effectiveAt: new Date(), changedBy: actorId });
        return copySku(sku);
    }

    // like the real table: size, color and the active flag change; the price does NOT change through update()
    async update(sku: Sku, actorId: string) {
        const stored = this.items.get(sku.getId())!;
        const next = copySku(stored);
        next.changeSize(sku.getSize());
        next.changeColor(sku.getColor());
        if (sku.isActive()) next.activate();
        else next.deactivate();
        this.items.set(sku.getId(), next);
        this.audit.set(sku.getId(), { createdBy: this.audit.get(sku.getId())?.createdBy ?? null, updatedBy: actorId });
        return copySku(next);
    }

    async changePrice(sku: Sku, actorId: string) {
        const stored = this.items.get(sku.getId())!;
        this.history.push({ id: randomUUID(), skuId: sku.getId(), oldPriceCents: stored.getStandardPriceCents(), newPriceCents: sku.getStandardPriceCents(), effectiveAt: new Date(), changedBy: actorId });
        stored.changePrice(sku.getStandardPriceCents());
        return copySku(stored);
    }

    async listPriceHistory(skuId: string, limit: number) {
        return this.history.filter((h) => h.skuId === skuId).reverse().slice(0, limit);
    }
}

export function makeStyle(overrides: Partial<StyleProps> = {}): Style {
    return Style.create({ id: randomUUID(), code: `ST-${randomUUID().slice(0, 8)}`, name: 'Nike Club Tee', category: 'Clothing', ...overrides });
}

export function makeSku(styleId: string, overrides: Partial<SkuProps> = {}): Sku {
    return Sku.create({ id: randomUUID(), styleId, skuCode: `SK-${randomUUID().slice(0, 8)}`, size: 'M', color: 'Red', standardPriceCents: 2500, ...overrides });
}

// everything a catalog use-case test needs, wired together
export function makeCatalog() {
    const styles = new FakeStyleRepository();
    const barcodes = new FakeBarcodeRepository();
    const skus = new FakeSkuRepository(styles, barcodes);
    return { styles, barcodes, skus };
}
