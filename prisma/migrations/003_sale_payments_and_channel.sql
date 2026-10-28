-- 003_sale_payments_and_channel.sql
-- BL-04: a sale is completed only when it is fully paid: in cash, by Whish Money, or by a combination.
-- The platform does NOT move money. It RECORDS what the business received (a Whish transfer counts only after
-- the business verified it and has its reference).

-- 1) How the customer ordered. B2B sales are not branch sales (BL-04: they stay warehouse operations).
ALTER TABLE sales
  ADD COLUMN channel         text NOT NULL DEFAULT 'in_store',
  ADD COLUMN social_platform text,
  ADD CONSTRAINT sales_channel_valid CHECK (channel IN ('in_store', 'social_media')),
  ADD CONSTRAINT sales_platform_matches_channel CHECK (
       (channel = 'in_store'     AND social_platform IS NULL)
    OR (channel = 'social_media' AND social_platform IS NOT NULL    -- a CHECK passes on NULL, so say it out loud
                                 AND social_platform IN ('facebook', 'instagram', 'whatsapp', 'other')));

-- 2) The money received for a sale, one row per method. A sale paid 20 cash + 25 Whish has two rows.
CREATE TABLE sale_payments (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id       uuid          NOT NULL REFERENCES sales(id),
  method        text          NOT NULL,
  amount        numeric(12,2) NOT NULL,          -- the part of the sale paid with this method (change is NOT included)
  cash_tendered numeric(12,2),                   -- cash only: what the customer handed over (change = tendered - amount)
  whish_reference text,                          -- Whish only: the transfer reference, never reusable
  received_by   uuid          NOT NULL REFERENCES users(id),
  created_at    timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT sale_payments_method_valid CHECK (method IN ('cash', 'whish')),
  CONSTRAINT sale_payments_amount_positive CHECK (amount > 0),
  CONSTRAINT sale_payments_shape CHECK (
       (method = 'cash'  AND cash_tendered IS NOT NULL AND cash_tendered >= amount AND whish_reference IS NULL)
    OR (method = 'whish' AND cash_tendered IS NULL AND whish_reference IS NOT NULL
                         AND whish_reference = btrim(whish_reference) AND length(whish_reference) > 0))
);
CREATE INDEX ix_sale_payments_sale ON sale_payments (sale_id);
-- a transfer reference can only ever pay ONE thing (case does not matter)
CREATE UNIQUE INDEX ux_sale_payments_whish_reference ON sale_payments (lower(whish_reference)) WHERE whish_reference IS NOT NULL;

-- payments are never edited or deleted; a mistake is corrected by a linked refund or reversal
CREATE TRIGGER trg_sale_payments_immutable BEFORE UPDATE OR DELETE ON sale_payments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_sale_payments_no_truncate BEFORE TRUNCATE ON sale_payments
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- 3) The database has the last word: at COMMIT, the payments of a sale must add up to its total EXACTLY.
--    (No unpaid completed sale, no overpayment.) It runs when a sale or a payment is inserted, and waits for COMMIT,
--    so the application can insert the sale first and its payments after, in the same transaction.
CREATE FUNCTION assert_sale_paid_exactly() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_sale_id uuid;
  v_total   numeric(12,2);
  v_paid    numeric(12,2);
BEGIN
  IF TG_TABLE_NAME = 'sales' THEN
    v_sale_id := NEW.id;
  ELSE
    v_sale_id := NEW.sale_id;
  END IF;
  SELECT total INTO v_total FROM sales WHERE id = v_sale_id;
  SELECT COALESCE(SUM(amount), 0) INTO v_paid FROM sale_payments WHERE sale_id = v_sale_id;
  IF v_paid <> v_total THEN
    RAISE EXCEPTION 'sale % must be paid exactly: total %, payments %', v_sale_id, v_total, v_paid
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_sales_paid_exactly AFTER INSERT ON sales
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_sale_paid_exactly();
CREATE CONSTRAINT TRIGGER trg_sale_payments_paid_exactly AFTER INSERT ON sale_payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_sale_paid_exactly();

-- 4) Audit view: sales whose payments do not add up to the total. It must always be EMPTY.
CREATE VIEW v_sale_payment_diffs AS
SELECT s.id AS sale_id, s.reference, s.total, COALESCE(SUM(p.amount), 0) AS paid
FROM sales s
LEFT JOIN sale_payments p ON p.sale_id = s.id
GROUP BY s.id, s.reference, s.total
HAVING COALESCE(SUM(p.amount), 0) <> s.total;
