import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { Barcode } from '../models/Barcode.model';
import { Sku } from '../models/Sku.model';
import { Style } from '../models/Style.model';
import { UserRole } from '../models/User.model';
import { createUserWithPassword } from '../test-helpers/createUserWithPassword';
import { waitForDatabase } from '../test-helpers/waitForDatabase';
import { ConflictError } from '../utils/exeptions/ConflictError';
import { NotFoundError } from '../utils/exeptions/NotFoundError';
import { BarcodeRepository } from './BarcodeRepository';
import { SkuRepository } from './SkuRepository';
import { StyleRepository } from './StyleRepository';
import { UserRepository } from './UserRepository';

// Real database. Every row made here has a code starting with `prefix`, so cleanup is exact.
const stamp = Date.now();
const prefix = `CI${stamp}`;
const styles = new StyleRepository(prisma);
const skus = new SkuRepository(prisma);
const barcodes = new BarcodeRepository(prisma);
let actorId = '';
let counter = 0;
const code = (tag: string) => `${prefix}-${tag}${++counter}`;
const newStyle = (patch = {}) => Style.create({ id: randomUUID(), code: code('S'), name: 'Integration Tee', ...patch });
const newSku = (styleId: string, patch = {}) => Sku.create({ id: randomUUID(), styleId, skuCode: code('K'), size: 'M', color: 'Red', standardPriceCents: 2500, ...patch });

beforeAll(async () => {
    await waitForDatabase(prisma);
    actorId = (await createUserWithPassword(new UserRepository(prisma), { email: `ci-${stamp}@bitar.test`, password: 'Password#123', fullName: 'CI Actor', role: UserRole.ADMIN }, null)).getId();
}, 60_000);

afterAll(async () => {
    const styleRows = await prisma.style.findMany({ where: { code: { startsWith: prefix } }, select: { id: true } });
    const styleIds = styleRows.map((s) => s.id);
    const skuIds = (await prisma.sku.findMany({ where: { styleId: { in: styleIds } }, select: { id: true } })).map((s) => s.id);
    await prisma.barcode.deleteMany({ where: { skuId: { in: skuIds } } });
    await prisma.skuPriceHistory.deleteMany({ where: { skuId: { in: skuIds } } });
    await prisma.sku.deleteMany({ where: { id: { in: skuIds } } });
    await prisma.style.deleteMany({ where: { id: { in: styleIds } } });
    if (actorId) await prisma.user.deleteMany({ where: { id: actorId } });
}, 60_000);

describe('StyleRepository (real database)', () => {
    it('saves and reads back a style, and the code is unique (P2002 becomes ConflictError)', async () => {
        const style = newStyle({ category: 'Tops' });
        const saved = await styles.save(style, actorId);
        expect(saved).toMatchObject({});
        expect((await styles.findByCode(style.getCode()))?.getId()).toBe(style.getId());
        expect((await prisma.style.findUnique({ where: { id: style.getId() } }))?.createdBy).toBe(actorId);

        const clash = Style.create({ id: randomUUID(), code: style.getCode(), name: 'Other' });
        await expect(styles.save(clash, actorId)).rejects.toBeInstanceOf(ConflictError);
    });

    it('update changes name, category and the flag, records the editor, and the touch trigger bumps the version', async () => {
        const style = newStyle();
        await styles.save(style, actorId);
        style.rename('Renamed');
        style.changeCategory('Bottoms');
        style.deactivate();
        await styles.update(style, actorId);
        const row = await prisma.style.findUnique({ where: { id: style.getId() } });
        expect(row).toMatchObject({ name: 'Renamed', category: 'Bottoms', isActive: false, updatedBy: actorId });
        expect(row!.version).toBe(2);
    });

    it('list searches code or name ignoring case, hides inactive ones on request, and pages', async () => {
        const name = `Findable ${stamp}`;
        const a = newStyle({ name: `${name} B` });
        const b = newStyle({ name: `${name} A` });
        await styles.save(a, actorId);
        await styles.save(b, actorId);
        b.deactivate();
        await styles.update(b, actorId);

        const all = await styles.list({ search: name.toUpperCase(), activeOnly: false, limit: 10, offset: 0 });
        expect(all.map((s) => s.getId())).toEqual([b.getId(), a.getId()]);
        expect((await styles.list({ search: name, activeOnly: true, limit: 10, offset: 0 })).map((s) => s.getId())).toEqual([a.getId()]);
        expect((await styles.list({ search: a.getCode().toLowerCase(), activeOnly: false, limit: 10, offset: 0 })).map((s) => s.getId())).toEqual([a.getId()]);
        expect((await styles.list({ search: name, activeOnly: false, limit: 1, offset: 1 })).map((s) => s.getId())).toEqual([a.getId()]);
    });
});

describe('SkuRepository (real database)', () => {
    it('saves the sku AND its first price-history row together; prices keep every cent', async () => {
        const style = newStyle();
        await styles.save(style, actorId);
        for (const [i, cents] of [7, 1999, 100, 999999999999].entries()) {
            const sku = newSku(style.getId(), { size: `S${i}`, standardPriceCents: cents });
            await skus.save(sku, actorId);
            expect((await skus.findById(sku.getId()))?.getStandardPriceCents()).toBe(cents);
            const history = await skus.listPriceHistory(sku.getId(), 10);
            expect(history).toHaveLength(1);
            expect(history[0]).toMatchObject({ oldPriceCents: null, newPriceCents: cents, changedBy: actorId });
        }
    });

    it('a failed save leaves NOTHING behind: no sku and no history row (it is one transaction)', async () => {
        const orphan = newSku(randomUUID());                                    // its style does not exist: foreign key refuses
        await expect(skus.save(orphan, actorId)).rejects.toThrow();
        expect(await prisma.sku.findUnique({ where: { id: orphan.getId() } })).toBeNull();
        expect(await prisma.skuPriceHistory.count({ where: { skuId: orphan.getId() } })).toBe(0);
    });

    it('the database itself refuses a duplicate code and a duplicate variant ignoring case and spaces', async () => {
        const style = newStyle();
        await styles.save(style, actorId);
        const first = newSku(style.getId(), { size: 'M', color: 'Red' });
        await skus.save(first, actorId);

        const sameCode = newSku(style.getId(), { skuCode: first.getSkuCode(), size: 'L' });
        await expect(skus.save(sameCode, actorId)).rejects.toBeInstanceOf(ConflictError);
        const sameVariant = newSku(style.getId(), { size: ' m ', color: 'RED' });
        await expect(skus.save(sameVariant, actorId)).rejects.toBeInstanceOf(ConflictError);
        expect(await prisma.skuPriceHistory.count({ where: { skuId: sameVariant.getId() } })).toBe(0);

        expect((await skus.findByVariant(style.getId(), 'M', 'red'))?.getId()).toBe(first.getId());
        expect(await skus.findByVariant(style.getId(), 'M', 'red', first.getId())).toBeNull();   // excluding itself
        expect((await skus.findBySkuCode(first.getSkuCode()))?.getId()).toBe(first.getId());
    });

    it('update changes size, color and the flag but NEVER the price', async () => {
        const style = newStyle();
        await styles.save(style, actorId);
        const sku = newSku(style.getId(), { standardPriceCents: 2500 });
        await skus.save(sku, actorId);
        sku.changeSize('XL');
        sku.changeColor('Green');
        sku.deactivate();
        sku.changePrice(9999);                                                  // an entity edit that must not reach the table through update()
        await skus.update(sku, actorId);
        const row = await prisma.sku.findUnique({ where: { id: sku.getId() } });
        expect(row).toMatchObject({ size: 'XL', color: 'Green', isActive: false, updatedBy: actorId });
        expect(row!.standardPrice.toFixed(2)).toBe('25.00');
        expect(row!.version).toBe(2);
    });

    it('changePrice writes the new price and a history row whose OLD price comes from the database, not from the entity', async () => {
        const style = newStyle();
        await styles.save(style, actorId);
        const sku = newSku(style.getId(), { standardPriceCents: 1000 });
        await skus.save(sku, actorId);

        const staleCopy = (await skus.findById(sku.getId()))!;                   // two callers loaded the same sku...
        const other = (await skus.findById(sku.getId()))!;
        other.changePrice(1100);
        await skus.changePrice(other, actorId);                                  // ...one of them changes the price first
        staleCopy.changePrice(1200);                                             // the other still believes the price is 10.00
        await skus.changePrice(staleCopy, actorId);

        const history = await skus.listPriceHistory(sku.getId(), 10);
        expect(history.map((h) => [h.oldPriceCents, h.newPriceCents])).toEqual([[1100, 1200], [1000, 1100], [null, 1000]]);   // a true chain
        expect((await skus.findById(sku.getId()))?.getStandardPriceCents()).toBe(1200);
    });

    it('changePrice on a sku that does not exist is a NotFoundError and writes nothing', async () => {
        const ghost = newSku(randomUUID());
        ghost.changePrice(1);
        await expect(skus.changePrice(ghost, actorId)).rejects.toBeInstanceOf(NotFoundError);
        expect(await prisma.skuPriceHistory.count({ where: { skuId: ghost.getId() } })).toBe(0);
    });

    it('findByBarcode returns the sku with its style; list searches sku code, color and style name', async () => {
        const style = newStyle({ name: `Barcode Style ${stamp}` });
        await styles.save(style, actorId);
        const sku = newSku(style.getId(), { color: 'Turquoise' });
        await skus.save(sku, actorId);
        const barcode = `${prefix}-0001`;
        await barcodes.save(Barcode.create({ id: randomUUID(), skuId: sku.getId(), code: barcode }), actorId);

        const found = await skus.findByBarcode(barcode);
        expect(found?.sku.getId()).toBe(sku.getId());
        expect(found?.style.getName()).toBe(`Barcode Style ${stamp}`);
        expect(await skus.findByBarcode(`${prefix}-9999`)).toBeNull();
        const bySearch = async (search: string) => (await skus.list({ search, activeOnly: false, limit: 10, offset: 0 })).map((r) => r.sku.getId());
        expect(await bySearch('turquoise')).toEqual([sku.getId()]);
        expect(await bySearch(`barcode style ${stamp}`)).toEqual([sku.getId()]);
        expect(await bySearch(sku.getSkuCode().toLowerCase())).toEqual([sku.getId()]);
        expect((await skus.listByStyle(style.getId())).map((s) => s.getId())).toEqual([sku.getId()]);
    });
});

describe('BarcodeRepository (real database)', () => {
    it('a barcode is unique in the whole catalog, can be listed per sku, and delete is safe to repeat', async () => {
        const style = newStyle();
        await styles.save(style, actorId);
        const a = newSku(style.getId(), { size: 'S' });
        const b = newSku(style.getId(), { size: 'L' });
        await skus.save(a, actorId);
        await skus.save(b, actorId);

        const first = await barcodes.save(Barcode.create({ id: randomUUID(), skuId: a.getId(), code: `${prefix}-UQ` }), actorId);
        await expect(barcodes.save(Barcode.create({ id: randomUUID(), skuId: b.getId(), code: `${prefix}-UQ` }), actorId)).rejects.toBeInstanceOf(ConflictError);
        expect((await barcodes.findByCode(`${prefix}-UQ`))?.getSkuId()).toBe(a.getId());
        expect((await barcodes.listBySku(a.getId())).map((x) => x.getCode())).toEqual([`${prefix}-UQ`]);
        expect(await barcodes.listBySku(b.getId())).toEqual([]);

        await barcodes.delete(first.getId());
        await barcodes.delete(first.getId());
        expect(await barcodes.findById(first.getId())).toBeNull();
    });
});
