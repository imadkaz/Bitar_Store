import { Barcode } from '../../models/Barcode.model';

export interface IBarcodeRepository {
    findById(id: string): Promise<Barcode | null>;
    findByCode(code: string): Promise<Barcode | null>;
    listBySku(skuId: string): Promise<Barcode[]>;
    save(barcode: Barcode, actorId: string | null): Promise<Barcode>;
    delete(id: string): Promise<void>;
}
