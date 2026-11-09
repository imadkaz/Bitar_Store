-- 013_suppliers.sql
-- BL-06: a supplier is a record (at least a name and a phone number) that managers keep and that every goods receipt links to.
-- Changing a supplier's phone later keeps the link to its past receipts; the receipt also keeps the NAME it had on the day (supplier_name).
-- The supplier's invoice number is OPTIONAL (BL-06: "optional when none is provided"); when it is given, the same number from the same supplier cannot come in twice.
CREATE TABLE suppliers (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  phone       text,
  note        text,
  is_active   boolean     NOT NULL DEFAULT true,
  created_by  uuid        REFERENCES users(id),
  updated_by  uuid        REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suppliers_name_valid CHECK (name = btrim(name) AND length(name) BETWEEN 2 AND 100),
  CONSTRAINT suppliers_phone_valid CHECK (phone IS NULL OR (phone = btrim(phone) AND length(phone) BETWEEN 5 AND 30)),
  CONSTRAINT suppliers_note_valid CHECK (note IS NULL OR length(note) <= 200)
);
CREATE UNIQUE INDEX ux_suppliers_name ON suppliers (lower(name));

-- the suppliers that already appear on receipts become records (their phone is not known yet: a manager fills it in)
INSERT INTO suppliers (name) SELECT DISTINCT ON (lower(supplier_name)) supplier_name FROM goods_receipts ORDER BY lower(supplier_name), created_at;

ALTER TABLE goods_receipts ADD COLUMN supplier_id uuid REFERENCES suppliers(id);
-- the receipts are immutable: the link is added once, here, with the guard off for this statement only
ALTER TABLE goods_receipts DISABLE TRIGGER trg_goods_receipts_immutable;
UPDATE goods_receipts g SET supplier_id = s.id FROM suppliers s WHERE lower(s.name) = lower(g.supplier_name);
ALTER TABLE goods_receipts ENABLE TRIGGER trg_goods_receipts_immutable;
ALTER TABLE goods_receipts ALTER COLUMN supplier_id SET NOT NULL;
CREATE INDEX ix_goods_receipts_supplier ON goods_receipts (supplier_id, created_at DESC);

ALTER TABLE goods_receipts ALTER COLUMN supplier_invoice_number DROP NOT NULL;
DROP INDEX ux_goods_receipts_supplier_invoice;
CREATE UNIQUE INDEX ux_goods_receipts_supplier_invoice ON goods_receipts (supplier_id, lower(supplier_invoice_number)) WHERE supplier_invoice_number IS NOT NULL;
