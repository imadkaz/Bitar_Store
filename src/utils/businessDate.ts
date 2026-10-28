// The shop's "day" is the day on the wall clock in Lebanon, not UTC: a sale at 00:30 local time belongs to the NEW day.
export const BUSINESS_TIME_ZONE = process.env.BUSINESS_TIME_ZONE ?? 'Asia/Beirut';

export function businessDateOf(instant: Date, timeZone: string = BUSINESS_TIME_ZONE): string {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
    return parts;   // en-CA formats as YYYY-MM-DD
}

export function isRealDate(text: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
    const date = new Date(`${text}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}
