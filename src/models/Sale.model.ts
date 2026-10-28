import { ValidationError } from "../utils/exeptions/ValidationError";
import { formatCents } from "./Money";
import { MAX_LINES, MAX_PAYMENTS, SALE_CHANNELS, SaleChannel, SaleLine, SaleLineInput, SOCIAL_PLATFORMS, SocialPlatform } from "./SaleLine.model";
import { PaymentInput, SalePayment } from "./SalePayment.model";

export interface SaleProps {
    id: string;
    branchId: string;
    soldBy: string;
    currency: string;
    channel?: SaleChannel;
    socialPlatform?: SocialPlatform | null;
    note?: string | null;
    businessDate: string;          // YYYY-MM-DD, the shop's day
    lines: SaleLineInput[];
    payments: PaymentInput[];
}

// A COMPLETED sale: it only exists fully paid (BL-04). The payments must add up to the total, to the cent.
export class Sale {
    private constructor(
        readonly id: string,
        readonly branchId: string,
        readonly soldBy: string,
        readonly currency: string,
        readonly channel: SaleChannel,
        readonly socialPlatform: SocialPlatform | null,
        readonly note: string | null,
        readonly businessDate: string,
        readonly lines: readonly SaleLine[],
        readonly payments: readonly SalePayment[],
        readonly subtotalCents: number,
        readonly discountCents: number,
        readonly totalCents: number,
    ) {}

    static create(props: SaleProps): Sale {
        if (props.lines.length < 1) throw new ValidationError('A sale needs at least one line');
        if (props.lines.length > MAX_LINES) throw new ValidationError(`A sale can have at most ${MAX_LINES} lines`);
        if (new Set(props.lines.map((l) => l.skuId)).size !== props.lines.length) {
            throw new ValidationError('Each sku can appear only once in a sale: raise its quantity instead');
        }

        const channel = props.channel ?? 'in_store';
        if (!SALE_CHANNELS.includes(channel)) throw new ValidationError('Channel must be in_store or social_media');
        let socialPlatform: SocialPlatform | null = null;
        if (channel === 'social_media') {
            if (!props.socialPlatform || !SOCIAL_PLATFORMS.includes(props.socialPlatform)) {
                throw new ValidationError(`A social media sale needs socialPlatform: ${SOCIAL_PLATFORMS.join(', ')}`);
            }
            socialPlatform = props.socialPlatform;
        } else if (props.socialPlatform) {
            throw new ValidationError('socialPlatform is only for social_media sales');
        }

        let note: string | null = null;
        if (props.note !== undefined && props.note !== null) {
            if (typeof props.note !== 'string') throw new ValidationError('Note must be text');
            note = props.note.trim() === '' ? null : props.note.trim();
            if (note !== null && note.length > 500) throw new ValidationError('Note must be at most 500 characters');
        }

        const lines = props.lines.map((input, index) => SaleLine.create(index + 1, input));
        const subtotal = lines.reduce((sum, l) => sum + l.lineStandardTotalCents, 0);
        const total = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);

        if (props.payments.length > MAX_PAYMENTS) throw new ValidationError(`A sale can have at most ${MAX_PAYMENTS} payments`);
        const payments = props.payments.map((p) => SalePayment.create(p, props.soldBy));
        const paid = payments.reduce((sum, p) => sum + p.amountCents, 0);
        if (total === 0 && payments.length > 0) throw new ValidationError('A sale with a total of zero has no payments');
        if (paid !== total) {
            throw new ValidationError(`The payments add up to ${formatCents(paid)} but the sale total is ${formatCents(total)}: a sale must be paid in full`);
        }

        return new Sale(props.id, props.branchId, props.soldBy, props.currency, channel, socialPlatform, note, props.businessDate, lines, payments, subtotal, subtotal - total, total);
    }
}
