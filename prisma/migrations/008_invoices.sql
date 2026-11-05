-- 008_invoices.sql
-- Invoices, one system for two kinds:
--   b2b = the SUPPLY invoice from the warehouse to a branch, made from a transfer. It starts as a DRAFT whose prices can be adjusted,
--         and becomes FINAL (numbered, locked) when the warehouse says so.
--   b2c = the invoice of a SALE to a customer (name and phone optional), final at once.
-- A final invoice never changes; a mistake is VOIDED (it stays, marked void, with the reason) and a new one is issued.
-- The names and descriptions are COPIED onto the invoice, so renaming a product or a branch later never changes an invoice already issued.

CREATE SEQUENCE invoice_b2b_ref_seq;
CREATE SEQUENCE invoice_b2c_ref_seq;

CREATE TABLE invoices (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text          NOT NULL,
  status              text          NOT NULL DEFAULT 'draft',
  reference           text,
  transfer_id         uuid          REFERENCES transfers(id),
  sale_id             uuid          REFERENCES sales(id),
  issuer_branch_id    uuid          NOT NULL REFERENCES branches(id),
  issuer_name         text          NOT NULL,
  recipient_branch_id uuid          REFERENCES branches(id),
  recipient_name      text,
  recipient_phone     text,
  currency            text          NOT NULL,
  subtotal            numeric(14,2) NOT NULL,
  discount_total      numeric(14,2) NOT NULL DEFAULT 0,
  total               numeric(14,2) NOT NULL,
  note                text,
  issued_by           uuid          NOT NULL REFERENCES users(id),
  created_at          timestamptz   NOT NULL DEFAULT now(),
  finalized_at        timestamptz,
  finalized_by        uuid          REFERENCES users(id),
  voided_at           timestamptz,
  voided_by           uuid          REFERENCES users(id),
  void_reason         text,
  CONSTRAINT invoices_kind_valid CHECK (kind IN ('b2b', 'b2c')),
  CONSTRAINT invoices_status_valid CHECK (status IN ('draft', 'final', 'void')),
  CONSTRAINT invoices_source_matches_kind CHECK (
       (kind = 'b2b' AND transfer_id IS NOT NULL AND sale_id IS NULL AND recipient_branch_id IS NOT NULL)
    OR (kind = 'b2c' AND sale_id IS NOT NULL AND transfer_id IS NULL)),
  CONSTRAINT invoices_reference_matches_status CHECK ((status = 'draft' AND reference IS NULL) OR (status IN ('final', 'void') AND reference IS NOT NULL)),
  CONSTRAINT invoices_finalized_matches_status CHECK (
       (status = 'draft' AND finalized_at IS NULL AND finalized_by IS NULL)
    OR (status IN ('final', 'void') AND finalized_at IS NOT NULL AND finalized_by IS NOT NULL)),
  CONSTRAINT invoices_void_matches_status CHECK (
       (status <> 'void' AND voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
    OR (status = 'void' AND voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL AND length(void_reason) BETWEEN 3 AND 200)),
  CONSTRAINT invoices_currency_valid CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT invoices_totals_valid CHECK (subtotal >= 0 AND discount_total >= 0 AND total = subtotal - discount_total AND total >= 0),
  CONSTRAINT invoices_text_valid CHECK (
       length(issuer_name) BETWEEN 1 AND 100
   AND (recipient_name IS NULL OR length(recipient_name) BETWEEN 1 AND 100)
   AND (recipient_phone IS NULL OR length(recipient_phone) BETWEEN 5 AND 30)
   AND (note IS NULL OR length(note) <= 200))
);
CREATE UNIQUE INDEX ux_invoices_reference ON invoices (reference) WHERE reference IS NOT NULL;
-- one live invoice per transfer and per sale (a void one does not count: that is how a corrected one is issued)
CREATE UNIQUE INDEX ux_invoices_transfer_live ON invoices (transfer_id) WHERE transfer_id IS NOT NULL AND status <> 'void';
CREATE UNIQUE INDEX ux_invoices_sale_live ON invoices (sale_id) WHERE sale_id IS NOT NULL AND status <> 'void';
CREATE INDEX ix_invoices_issuer_created ON invoices (issuer_branch_id, created_at DESC);
CREATE INDEX ix_invoices_recipient_created ON invoices (recipient_branch_id, created_at DESC) WHERE recipient_branch_id IS NOT NULL;
CREATE INDEX ix_invoices_created ON invoices (created_at DESC);

CREATE TABLE invoice_lines (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      uuid          NOT NULL REFERENCES invoices(id),
  line_no         smallint      NOT NULL,
  sku_id          uuid          NOT NULL REFERENCES skus(id),
  sku_code        text          NOT NULL,
  description     text          NOT NULL,
  quantity        integer       NOT NULL,
  unit_price      numeric(12,2) NOT NULL,
  discount_amount numeric(12,2) NOT NULL DEFAULT 0,
  line_total      numeric(14,2) NOT NULL,
  CONSTRAINT invoice_lines_line_unique UNIQUE (invoice_id, line_no),
  CONSTRAINT invoice_lines_quantity_positive CHECK (quantity > 0),
  CONSTRAINT invoice_lines_amounts_valid CHECK (unit_price >= 0 AND discount_amount >= 0 AND line_total >= 0 AND line_total = quantity * unit_price - discount_amount)
);
CREATE INDEX ix_invoice_lines_sku ON invoice_lines (sku_id);

-- WHO MAY CHANGE WHAT
--   a DRAFT changes freely (its prices), but what it is made from never changes; only a draft can be deleted
--   a FINAL invoice can only become VOID (with who, when and why): nothing else
--   a VOID invoice never changes
--   the lines of an invoice can change only while it is a draft
CREATE FUNCTION invoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'Only a draft invoice can be deleted: void a final one instead' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'void' THEN RAISE EXCEPTION 'A void invoice cannot change' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF OLD.status = 'final' THEN
    IF NEW.status <> 'void' OR (to_jsonb(NEW) - ARRAY['status','voided_at','voided_by','void_reason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','voided_at','voided_by','void_reason']) THEN
      RAISE EXCEPTION 'A final invoice cannot be changed: void it and issue a new one' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind <> OLD.kind OR NEW.transfer_id IS DISTINCT FROM OLD.transfer_id OR NEW.sale_id IS DISTINCT FROM OLD.sale_id
     OR NEW.issuer_branch_id <> OLD.issuer_branch_id OR NEW.recipient_branch_id IS DISTINCT FROM OLD.recipient_branch_id OR NEW.issued_by <> OLD.issued_by THEN
    RAISE EXCEPTION 'What an invoice is made from cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_invoices_guard BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_guard();

CREATE FUNCTION invoice_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent text;
BEGIN
  SELECT status INTO parent FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF parent IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'The lines of an invoice change only while it is a draft' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trg_invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines FOR EACH ROW EXECUTE FUNCTION invoice_lines_guard();
