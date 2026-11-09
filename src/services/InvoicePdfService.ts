import path from 'node:path';
import PDFDocument from 'pdfkit';
import { InvoiceView } from '../repositories/interfaces/IInvoiceRepository';

// The invoice as a PDF, made when it is asked for (nothing is stored). The font (DejaVu Sans) has Latin and Arabic letters.
// pdfkit joins the Arabic letters of a word correctly but does not do right-to-left layout of a LINE (it loses the spaces and mixes the
// order). So a line with Arabic is drawn WORD BY WORD from the right edge: each word is shaped alone, the words go right to left,
// brackets are mirrored, and what does not fit gets an ellipsis. Checked with pure Arabic, pure Latin and mixed lines.
const FONT_DIR = path.resolve(process.cwd(), 'assets/fonts');
const REGULAR = path.join(FONT_DIR, 'DejaVuSans.ttf');
const BOLD = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');
const ARABIC = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };

export const isRtl = (text: string): boolean => ARABIC.test(text);
// in a right-to-left line the brackets face the other way
export const mirrorBrackets = (word: string): string => word.replace(/[()[\]{}<>]/g, (c) => MIRROR[c]);
// the words of a line in the order they are DRAWN (left to right on the page)
export const visualOrder = (text: string): string => (isRtl(text) ? text.split(' ').reverse().map(mirrorBrackets).join(' ') : text);

const COMPANY = 'Bitar Fashion';
const TITLE = { b2b: 'SUPPLY INVOICE', b2b_return: 'RETURN INVOICE', b2c: 'INVOICE' } as const;
const INK = '#1f2937', MUTED = '#6b7280', LINE = '#d1d5db', SOFT = '#f3f4f6', ACCENT = '#92400e', RED = '#b91c1c';

const day = (date: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Beirut', day: '2-digit', month: 'short', year: 'numeric' }).format(date);
const money = (amount: string, currency: string) => `${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

export function renderInvoicePdf(invoice: InvoiceView): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: invoice.reference ?? 'Draft invoice', Author: COMPANY } });
        const chunks: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const left = 40, right = doc.page.width - 40, width = right - left;
        type TextOptions = { width?: number; align?: 'left' | 'right' | 'center'; size?: number; bold?: boolean; color?: string };
        const fit = (value: string, maxWidth: number): string => {
            if (doc.widthOfString(value) <= maxWidth) return value;
            let cut = value;
            while (cut.length > 1 && doc.widthOfString(`${cut}...`) > maxWidth) cut = cut.slice(0, -1);
            return `${cut}...`;
        };
        const text = (value: string, x: number, y: number, options: TextOptions = {}) => {
            const maxWidth = options.width ?? width;
            doc.font(options.bold ? BOLD : REGULAR).fontSize(options.size ?? 9.5).fillColor(options.color ?? INK);
            if (!isRtl(value)) {
                doc.text(fit(value, maxWidth), x, y, { width: maxWidth, align: options.align ?? 'left', lineBreak: false });
                return;
            }
            // right to left: from the right edge of the box, word by word
            const space = doc.widthOfString(' ');
            const words: string[] = [];
            let used = 0;
            for (const word of value.split(' ')) {
                const w = doc.widthOfString(mirrorBrackets(word));
                if (used + w > maxWidth && words.length > 0) { words.push('...'); break; }
                words.push(word);
                used += w + space;
            }
            let cursor = x + maxWidth;
            for (const word of words) {
                const shown = word === '...' ? word : mirrorBrackets(word);
                cursor -= doc.widthOfString(shown);
                doc.text(shown, cursor, y, { lineBreak: false });
                cursor -= space;
            }
        };

        // header
        text(COMPANY, left, 40, { size: 20, bold: true, width: 260 });
        text(TITLE[invoice.kind], left, 40, { size: 14, bold: true, align: 'right', color: ACCENT });
        text(invoice.reference ?? 'DRAFT: not final yet', left, 60, { size: 11, align: 'right', bold: invoice.reference !== null });
        const shownDate = invoice.finalizedAt ?? invoice.createdAt;
        text(`Date: ${day(shownDate)}`, left, 76, { align: 'right', color: MUTED });
        doc.moveTo(left, 96).lineTo(right, 96).strokeColor(LINE).stroke();

        // from / to
        text(invoice.kind !== 'b2c' ? 'FROM' : 'ISSUED BY', left, 108, { size: 8, color: MUTED, width: 240 });
        text(invoice.issuer.name, left, 120, { size: 11, bold: true, width: 240 });
        text(invoice.kind !== 'b2c' ? 'TO' : 'CUSTOMER', left + 270, 108, { size: 8, color: MUTED, width: 240 });
        text(invoice.recipient.name ?? (invoice.kind === 'b2c' ? 'Walk-in customer' : '-'), left + 270, 120, { size: 11, bold: true, width: 240 });
        if (invoice.recipient.phone) text(invoice.recipient.phone, left + 270, 136, { color: MUTED, width: 240 });
        const source = invoice.transfer ? `Transfer ${invoice.transfer.reference}` : invoice.sale ? `Sale ${invoice.sale.reference}` : '';
        text(`${source}   Issued by ${invoice.issuedBy.name ?? '-'}`, left, 152, { size: 8.5, color: MUTED });

        // lines
        const columns = { no: left, code: left + 22, description: left + 120, qty: left + 298, price: left + 336, discount: left + 402, total: left + 462 };
        let y = 178;
        doc.rect(left, y - 4, width, 18).fill(SOFT);
        text('#', columns.no + 2, y, { size: 8.5, bold: true, width: 20 });
        text('Code', columns.code, y, { size: 8.5, bold: true, width: 95 });
        text('Description', columns.description, y, { size: 8.5, bold: true, width: 172 });
        text('Qty', columns.qty, y, { size: 8.5, bold: true, width: 34, align: 'right' });
        text('Price', columns.price, y, { size: 8.5, bold: true, width: 62, align: 'right' });
        text('Discount', columns.discount, y, { size: 8.5, bold: true, width: 52, align: 'right' });
        text('Total', columns.total, y, { size: 8.5, bold: true, width: right - columns.total, align: 'right' });
        y += 20;
        const newPage = () => { doc.addPage(); y = 40; };
        for (const line of invoice.lines) {
            if (y > doc.page.height - 150) newPage();
            text(String(line.lineNo), columns.no + 2, y, { width: 20, color: MUTED });
            text(line.sku.code, columns.code, y, { width: 95 });
            text(line.description, columns.description, y, { width: 172 });
            text(String(line.quantity), columns.qty, y, { width: 34, align: 'right' });
            text(Number(line.unitPrice).toFixed(2), columns.price, y, { width: 62, align: 'right' });
            text(Number(line.discount) > 0 ? Number(line.discount).toFixed(2) : '-', columns.discount, y, { width: 52, align: 'right', color: MUTED });
            text(Number(line.lineTotal).toFixed(2), columns.total, y, { width: right - columns.total, align: 'right' });
            y += 17;
            doc.moveTo(left, y - 4).lineTo(right, y - 4).strokeColor(SOFT).stroke();
        }

        // totals
        y += 8;
        if (y > doc.page.height - 170) newPage();
        const labelX = left + 300, valueW = right - (left + 300);
        const row = (label: string, value: string, bold = false) => {
            text(label, labelX, y, { width: 100, bold, color: bold ? INK : MUTED });
            text(value, labelX, y, { width: valueW, align: 'right', bold });
            y += 16;
        };
        row('Subtotal', money(invoice.subtotal, invoice.currency));
        if (Number(invoice.discountTotal) > 0) row('Discount', `- ${money(invoice.discountTotal, invoice.currency)}`);
        doc.moveTo(labelX, y - 2).lineTo(right, y - 2).strokeColor(LINE).stroke();
        y += 4;
        row('TOTAL', money(invoice.total, invoice.currency), true);
        if (invoice.totalLbp != null && invoice.exchangeRate != null) {
            text(`In pounds (1 USD = ${invoice.exchangeRate.toLocaleString('en-US')} LBP)`, labelX, y, { width: 150, color: MUTED });
            text(`${invoice.totalLbp.toLocaleString('en-US')} LBP`, labelX, y, { width: valueW, align: 'right' });
            y += 16;
        }

        if (invoice.payments.length > 0) {
            y += 6;
            text('PAID BY', labelX, y, { size: 8, color: MUTED });
            y += 12;
            for (const payment of invoice.payments) {
                text(payment.method === 'whish' ? `Whish${payment.reference ? ` (${payment.reference})` : ''}` : payment.currency === 'LBP' ? 'Cash in pounds' : 'Cash', labelX, y, { width: 150, color: MUTED });
                text(payment.currency === 'LBP' && payment.lbpAmount != null ? `${payment.lbpAmount.toLocaleString('en-US')} LBP = ${money(payment.amount, invoice.currency)}` : money(payment.amount, invoice.currency), labelX, y, { width: valueW, align: 'right' });
                y += 14;
                if (payment.changeLbp) { text('Change given in pounds', labelX, y, { width: 150, color: MUTED }); text(`${payment.changeLbp.toLocaleString('en-US')} LBP`, labelX, y, { width: valueW, align: 'right' }); y += 14; }
            }
        }
        if (invoice.note) { y += 10; text(`Note: ${invoice.note}`, left, y, { size: 8.5, color: MUTED, width: 280 }); }

        // a draft and a void invoice are marked on every page
        const mark = invoice.status === 'draft' ? 'DRAFT' : invoice.status === 'void' ? 'VOID' : null;
        const pages = doc.bufferedPageRange();
        for (let i = pages.start; i < pages.start + pages.count; i++) {
            doc.switchToPage(i);
            if (mark) {
                doc.save().rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] }).font(BOLD).fontSize(96).fillColor(invoice.status === 'void' ? RED : MUTED).opacity(0.12)
                    .text(mark, 0, doc.page.height / 2 - 50, { width: doc.page.width, align: 'center', lineBreak: false }).restore();
            }
        }
        if (invoice.voided) {
            doc.switchToPage(pages.start + pages.count - 1);
            text(`VOID on ${day(invoice.voided.at)}: ${invoice.voided.reason}`, left, doc.page.height - 70, { size: 9, bold: true, color: RED });
        }
        doc.flushPages();
        doc.end();
    });
}
