-- 014_transfer_receipts.sql
-- Every time the destination counts what arrived, that count is KEPT: who, when, the note of what was found (wet cartons, seams checked...)
-- and how many of each product were accepted and how many damaged. It used to live only in the browser tab of the person who counted.
-- A receipt is never edited or deleted. A transfer received before this migration simply has none.
CREATE TABLE transfer_receipts (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id        uuid        NOT NULL REFERENCES transfers(id),
  received_by        uuid        NOT NULL REFERENCES users(id),
  received_at        timestamptz NOT NULL DEFAULT now(),
  note               text,
  idempotency_key_id uuid        REFERENCES idempotency_keys(id),
  CONSTRAINT transfer_receipts_note_valid CHECK (note IS NULL OR (note = btrim(note) AND length(note) BETWEEN 1 AND 500))
);
CREATE INDEX ix_transfer_receipts_transfer ON transfer_receipts (transfer_id, received_at);

CREATE TABLE transfer_receipt_lines (
  id           uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id   uuid    NOT NULL REFERENCES transfer_receipts(id),
  sku_id       uuid    NOT NULL REFERENCES skus(id),
  accepted_qty integer NOT NULL,
  damaged_qty  integer NOT NULL DEFAULT 0,
  CONSTRAINT transfer_receipt_lines_unique UNIQUE (receipt_id, sku_id),
  CONSTRAINT transfer_receipt_lines_qty_valid CHECK (accepted_qty >= 0 AND damaged_qty >= 0 AND accepted_qty + damaged_qty > 0)
);
CREATE INDEX ix_transfer_receipt_lines_sku ON transfer_receipt_lines (sku_id);

CREATE TRIGGER trg_transfer_receipts_immutable BEFORE UPDATE OR DELETE ON transfer_receipts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_transfer_receipt_lines_immutable BEFORE UPDATE OR DELETE ON transfer_receipt_lines FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
