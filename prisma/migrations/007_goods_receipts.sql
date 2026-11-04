-- 007_goods_receipts.sql
-- Goods from a SUPPLIER come into the WAREHOUSE as a document: supplier name, the supplier's invoice number, its date,
-- and for each product the quantity and the price paid. The warehouse stock grows from that document in the same transaction.
-- (Opening stock stays what it is: the first count when the system starts. Every delivery after that is a goods receipt.)

CREATE SEQUENCE goods_receipt_ref_seq;

CREATE TABLE goods_receipts (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reference               text        NOT NULL DEFAULT ('GR-' || lpad(nextval('goods_receipt_ref_seq')::text, 8, '0')),
  branch_id               uuid        NOT NULL REFERENCES branches(id),
  supplier_name           text        NOT NULL,
  supplier_invoice_number text        NOT NULL,
  invoice_date            date        NOT NULL,
  currency                text        NOT NULL DEFAULT 'USD',
  note                    text,
  total_cost              numeric(14,2) NOT NULL,
  received_by             uuid        NOT NULL REFERENCES users(id),
  idempotency_key_id      uuid        NOT NULL REFERENCES idempotency_keys(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_goods_receipts_reference UNIQUE (reference),
  CONSTRAINT goods_receipts_idempotency_key_unique UNIQUE (idempotency_key_id),
  CONSTRAINT goods_receipts_supplier_valid CHECK (supplier_name = btrim(supplier_name) AND length(supplier_name) BETWEEN 2 AND 100),
  CONSTRAINT goods_receipts_invoice_number_valid CHECK (supplier_invoice_number = btrim(supplier_invoice_number) AND length(supplier_invoice_number) BETWEEN 1 AND 50),
  CONSTRAINT goods_receipts_currency_valid CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT goods_receipts_note_valid CHECK (note IS NULL OR length(note) <= 200),
  CONSTRAINT goods_receipts_total_nonneg CHECK (total_cost >= 0)
);
-- the same supplier invoice cannot be received twice (a double entry), whatever the letter case
CREATE UNIQUE INDEX ux_goods_receipts_supplier_invoice ON goods_receipts (lower(supplier_name), lower(supplier_invoice_number));
CREATE INDEX ix_goods_receipts_branch_created ON goods_receipts (branch_id, created_at DESC);
CREATE INDEX ix_goods_receipts_created ON goods_receipts (created_at DESC);

CREATE TABLE goods_receipt_lines (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id  uuid          NOT NULL REFERENCES goods_receipts(id),
  sku_id      uuid          NOT NULL REFERENCES skus(id),
  quantity    integer       NOT NULL,
  unit_cost   numeric(12,2) NOT NULL,
  CONSTRAINT goods_receipt_lines_unique_sku UNIQUE (receipt_id, sku_id),
  CONSTRAINT goods_receipt_lines_quantity_positive CHECK (quantity > 0),
  CONSTRAINT goods_receipt_lines_cost_nonneg CHECK (unit_cost >= 0)
);
CREATE INDEX ix_goods_receipt_lines_sku ON goods_receipt_lines (sku_id);

-- a receipt and its lines are history: never edited, never deleted (a mistake is corrected with a stock adjustment)
CREATE TRIGGER trg_goods_receipts_immutable      BEFORE UPDATE OR DELETE ON goods_receipts      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_goods_receipt_lines_immutable BEFORE UPDATE OR DELETE ON goods_receipt_lines FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- goods come in at the warehouse only
CREATE FUNCTION forbid_receipt_outside_warehouse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM branches WHERE id = NEW.branch_id AND kind = 'warehouse') THEN
    RAISE EXCEPTION 'Goods from a supplier are received at the warehouse only';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_goods_receipts_warehouse_only BEFORE INSERT ON goods_receipts FOR EACH ROW EXECUTE FUNCTION forbid_receipt_outside_warehouse();

-- the stock ledger learns the new kind of movement
ALTER TABLE stock_movements ADD COLUMN goods_receipt_id uuid REFERENCES goods_receipts(id);
CREATE INDEX ix_stock_movements_goods_receipt ON stock_movements (goods_receipt_id) WHERE goods_receipt_id IS NOT NULL;

ALTER TABLE stock_movements DROP CONSTRAINT movements_type_valid;
ALTER TABLE stock_movements ADD CONSTRAINT movements_type_valid CHECK (movement_type = ANY (ARRAY['opening','sale','sale_reversal','return','transfer_dispatch','transfer_receipt','transfer_return','transfer_resolution','adjustment','goods_receipt']));
ALTER TABLE stock_movements DROP CONSTRAINT movements_one_reference;
ALTER TABLE stock_movements ADD CONSTRAINT movements_one_reference CHECK (num_nonnulls(sale_id, transfer_id, adjustment_id, import_batch_id, goods_receipt_id) = 1);
ALTER TABLE stock_movements DROP CONSTRAINT movements_reference_matches_type;
ALTER TABLE stock_movements ADD CONSTRAINT movements_reference_matches_type CHECK (
     (movement_type = ANY (ARRAY['sale','sale_reversal','return']) AND sale_id IS NOT NULL)
  OR (movement_type = ANY (ARRAY['transfer_dispatch','transfer_receipt','transfer_return','transfer_resolution']) AND transfer_id IS NOT NULL)
  OR (movement_type = 'adjustment' AND adjustment_id IS NOT NULL)
  OR (movement_type = 'opening' AND import_batch_id IS NOT NULL)
  OR (movement_type = 'goods_receipt' AND goods_receipt_id IS NOT NULL)
);
