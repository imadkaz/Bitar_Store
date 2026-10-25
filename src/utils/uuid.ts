
// src/utils/uuid.ts
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A uuid column rejects any other text with a database error (500). Check first, answer 404/401 instead.
export function isUuid(value: string): value is string {
    return typeof value === 'string' && UUID.test(value);
}