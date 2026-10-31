import { PriceChange, Sku } from '../../models/Sku.model';
import { Style } from '../../models/Style.model';

export interface SkuWithStyle {
    sku: Sku;
    style: Style;
}

export interface SkuFilter {
    styleId?: string;
    search?: string;        // matches the sku code, the color or the style name, ignoring case
    activeOnly: boolean;
    limit: number;
    offset: number;
}

export interface ISkuRepository {
    findById(id: string): Promise<Sku | null>;
    findWithStyleById(id: string): Promise<SkuWithStyle | null>;
    findBySkuCode(code: string): Promise<Sku | null>;
    // same style + same size + same color, ignoring case and spaces (excludeId = the sku being edited)
    findByVariant(styleId: string, size: string, color: string, excludeId?: string): Promise<Sku | null>;
    findByBarcode(code: string): Promise<SkuWithStyle | null>;
    list(filter: SkuFilter): Promise<SkuWithStyle[]>;
    listByStyle(styleId: string): Promise<Sku[]>;
    // creates the sku AND its first price-history row in one transaction
    save(sku: Sku, actorId: string): Promise<Sku>;
    // size, color and active flag only: never the price
    update(sku: Sku, actorId: string): Promise<Sku>;
    // locks the row, writes the new price AND the history row (old price read inside the lock) in one transaction
    changePrice(sku: Sku, actorId: string): Promise<Sku>;
    listPriceHistory(skuId: string, limit: number): Promise<PriceChange[]>;
    count(filter: Omit<SkuFilter, 'limit' | 'offset'>): Promise<number>;
}
