// npx tsx scripts/import-catalog.ts --file path/to/skus.csv --actor manager@bitar.demo                     (DRY RUN: checks every row, writes nothing)
// npx tsx scripts/import-catalog.ts --file path/to/skus.csv --actor manager@bitar.demo --yes               (creates the styles and skus, and sets the catalog costs)
//   --no-costs        do not set the catalog costs (the costs of the sheet are ESTIMATES: with them the profit report is approximate)
//   --allow-remote    needed when DATABASE_URL is a remote (Neon) database
// It goes through the real rules of the API (the same checks, the price history, the audit log of categories and costs). It is safe to run again: what exists is skipped, a catalog cost already set is never overwritten.
// The file is the SKU sheet saved as CSV with the columns: model_code, product_name, category, sku, color, size, unit_cost_usd_est, sell_price_usd, material_as_written.
import 'dotenv/config';
import fs from 'node:fs';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const fail = (message: string): never => { console.error(`\n✗ ${message}\n`); process.exit(1); };

async function main() {
    const host = (() => { try { return new URL(process.env.DATABASE_URL ?? '').host; } catch { return '(unreadable DATABASE_URL)'; } })();
    console.log(`Database: ${host}`);
    if (/neon\.tech/i.test(host) && !args.includes('--allow-remote')) fail('This is a remote (Neon) database. Add --allow-remote when you are sure it is the right one.');
    const file = flag('--file'), actorEmail = flag('--actor');
    if (!file || !fs.existsSync(file)) fail('Give the file: --file path/to/skus.csv');
    if (!actorEmail) fail('Say who does this: --actor manager@bitar.demo (an admin or a manager: the costs and categories are written to the audit log with this person).');
    if (!process.env.JWT_SECRET) fail('JWT_SECRET is not set');
    process.env.AUTH_MODE = process.env.AUTH_MODE ?? 'jwt';

    const { prisma } = await import('../src/db');
    const { planImport, readRows } = await import('../src/usecases/catalog/ImportCatalog');
    const { formatCents } = await import('../src/models/Money');
    const actor = await prisma.user.findFirst({ where: { email: actorEmail!.toLowerCase() } });
    if (!actor || (actor.role !== 'admin' && actor.role !== 'manager')) fail(`${actorEmail} is not an admin or a manager of this database.`);

    const { rows, problems } = readRows(fs.readFileSync(file!, 'utf8'));
    if (problems.length > 0) fail(problems.join('; '));
    const codes = rows.map((r) => r.modelCode.trim().toUpperCase()).filter(Boolean);
    const skuCodes = rows.map((r) => r.sku.trim().toUpperCase()).filter(Boolean);
    const existingStyles = new Set((await prisma.style.findMany({ where: { code: { in: codes } }, select: { code: true } })).map((s) => s.code));
    const existingSkus = new Set((await prisma.sku.findMany({ where: { skuCode: { in: skuCodes } }, select: { skuCode: true } })).map((s) => s.skuCode));
    const plan = planImport(rows, existingStyles, existingSkus);
    const withCosts = !args.includes('--no-costs');
    // a style can only use a category that exists (the app refuses otherwise): the missing ones are created first, an existing one is used with its own spelling
    const known = new Map((await prisma.category.findMany({ select: { name: true } })).map((c) => [c.name.trim().toLowerCase(), c.name]));
    const wanted = [...new Set(plan.styles.map((st) => st.category).filter((c): c is string => c !== null))];
    const categoriesToCreate = wanted.filter((c) => !known.has(c.toLowerCase()));

    console.log(`\nThe file has ${rows.length} rows.`);
    console.log(`  styles to create: ${plan.styles.length}${plan.styles.length ? ' -> ' + plan.styles.map((s) => `${s.code} "${s.name}" (${s.category ?? 'no category'}, ${s.skus} skus)`).join('; ') : ''}`);
    console.log(`  categories to create: ${categoriesToCreate.length}${categoriesToCreate.length ? ' -> ' + categoriesToCreate.join(', ') : ''}`);
    console.log(`  skus to create:   ${plan.skus.length}     already in the database (skipped): ${plan.existingSkus.length}`);
    console.log(`  catalog costs to set: ${withCosts ? plan.skus.filter((s) => s.costCents !== null).length : 0}${withCosts ? '  (ESTIMATES: the profit built on them is approximate)' : '  (--no-costs)'}`);
    if (plan.withoutPrice.length > 0) {
        const byModel = new Map<string, number>();
        for (const r of plan.withoutPrice) byModel.set(r.sku.split('-C')[0], (byModel.get(r.sku.split('-C')[0]) ?? 0) + 1);
        console.log(`  NOT imported, no selling price in the file: ${plan.withoutPrice.length} skus (${[...byModel].map(([m, n]) => `${m}: ${n}`).join(', ')}). Give them a price and run again.`);
    }
    for (const w of plan.warnings) console.log(`  ! ${w}`);
    if (plan.invalid.length > 0) {
        console.log(`\n✗ ${plan.invalid.length} row(s) are refused by the rules of the app. NOTHING was written:`);
        for (const r of plan.invalid.slice(0, 30)) console.log(`    line ${r.line} ${r.sku}: ${r.reason}`);
        process.exit(1);
    }
    const reviewFile = file!.replace(/\.csv$/i, '_review.csv');
    if (fs.existsSync(reviewFile)) {
        const review = readReview(fs.readFileSync(reviewFile, 'utf8'));
        if (review.length > 0) {
            console.log('\nThe sheet itself says these models need confirmation (they are imported as written; rename them later with PATCH /styles/:id):');
            for (const r of review) console.log(`  - ${r.model} "${r.name}": ${r.question}`);
        }
    }
    if (!args.includes('--yes')) { console.log('\nDry run: nothing was written. Add --yes to import.'); await prisma.$disconnect(); return; }

    const { default: request } = await import('supertest');
    const { app } = await import('../src/app');
    const { JwtTokenService } = await import('../src/services/JwtTokenService');
    const auth = { Authorization: `Bearer ${new JwtTokenService(process.env.JWT_SECRET!).sign(actor!.id)}` };
    let stylesDone = 0, skusDone = 0, costsDone = 0, costsKept = 0;
    const errors: string[] = [];
    const styleIds = new Map<string, string>((await prisma.style.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } })).map((s) => [s.code, s.id]));
    for (const name of categoriesToCreate) {
        const made = await request(app).post('/categories').set(auth).send({ name });
        if (made.status === 201 || made.status === 409) known.set(name.toLowerCase(), name); else fail(`category ${name}: ${made.status} ${made.body?.message ?? ''}. Nothing else was written.`);
    }
    if (categoriesToCreate.length > 0) console.log(`  categories created: ${categoriesToCreate.join(', ')}`);
    for (const style of plan.styles) {
        const category = style.category ? known.get(style.category.toLowerCase()) ?? style.category : null;
        const res = await request(app).post('/styles').set(auth).send({ code: style.code, name: style.name, ...(category ? { category } : {}) });
        if (res.status === 201) { styleIds.set(style.code, res.body.id); stylesDone++; } else errors.push(`style ${style.code}: ${res.status} ${res.body?.message ?? ''}`);
    }
    for (const sku of plan.skus) {
        const styleId = styleIds.get(sku.styleCode);
        if (!styleId) { errors.push(`sku ${sku.skuCode}: its style ${sku.styleCode} was not created`); continue; }
        const res = await request(app).post('/skus').set(auth).send({ styleId, skuCode: sku.skuCode, size: sku.size, color: sku.color, standardPrice: formatCents(sku.priceCents) });
        if (res.status !== 201) { errors.push(`sku ${sku.skuCode}: ${res.status} ${res.body?.message ?? ''}`); continue; }
        skusDone++;
        if (withCosts && sku.costCents !== null) {
            const current = await request(app).get(`/costs/skus/${res.body.id}`).set(auth);
            if (current.status === 200 && current.body.catalogCost === null) {
                const set = await request(app).put(`/costs/skus/${res.body.id}`).set(auth).send({ unitCost: formatCents(sku.costCents) });
                if (set.status === 200) costsDone++; else errors.push(`cost ${sku.skuCode}: ${set.status} ${set.body?.message ?? ''}`);
            } else costsKept++;
        }
    }
    console.log(`\n${errors.length ? '!' : '✓'} created ${stylesDone} style(s) and ${skusDone} sku(s); ${costsDone} catalog cost(s) set${costsKept ? `, ${costsKept} already had one (kept)` : ''}. Each sku starts its price history; the categories and the costs are in the audit log (by ${actorEmail}).`);
    if (errors.length > 0) { console.log(`✗ ${errors.length} failure(s):`); for (const e of errors.slice(0, 30)) console.log(`    ${e}`); await prisma.$disconnect(); process.exit(1); }
    console.log('  Stock: the sheet has no quantities, so every product starts with 0. Add stock with goods receipts (or opening stock).');
    await prisma.$disconnect();
}

function readReview(text: string): { model: string; name: string; question: string }[] {
    return text.split(/\r?\n/).slice(1).filter(Boolean).map((line) => { const m = line.match(/^([^,]*),("(?:[^"]|"")*"|[^,]*),("(?:[^"]|"")*"|[^,]*)/); return m ? { model: m[1], name: m[2].replace(/^"|"$/g, ''), question: m[3].replace(/^"|"$/g, '') } : { model: line, name: '', question: '' }; });
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
