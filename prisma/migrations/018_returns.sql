-- 018_returns.sql
-- Customer returns (approved BL-04). The goods first sit in CUSTODY (they still belong to the customer: not in the business stock); a manager decides:
--   approved -> the goods enter the business stock ON HOLD at the receiving branch, once, and the refund is owed; a manager releases them to sale separately
--   rejected -> awaiting handback, no refund, no stock effect; handing them back closes the return
-- The refund is the amount actually PAID for the returned units after discounts (never today's price), paid separately (cash or Whish), never more than was paid.
-- A return can be made at ANY branch, linked to the original sale. Receiving, approving, releasing and paying a refund are distinct events.

ALTER TABLE user_permission_overrides DROP CONSTRAINT upo_permission_valid;
ALTER TABLE user_permission_overrides ADD CONSTRAINT upo_permission_valid CHECK (permission IN (
  'sales.create','discounts.apply','catalog.create','transfers.dispatch','transfers.receive',
  'returns.create','returns.refund','adjustments.create','reports.financial','users.administer',
  'cash.open','cash.accept','cash.close','cash.move'));

CREATE SEQUENCE return_ref_seq;
CREATE TABLE returns (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reference             text        NOT NULL DEFAULT ('RET-' || lpad(nextval('return_ref_seq')::text, 8, '0')),
  sale_id               uuid        NOT NULL REFERENCES sales(id),
  receiving_branch_id   uuid        NOT NULL REFERENCES branches(id),
  status                text        NOT NULL DEFAULT 'in_custody',
  custody               text        NOT NULL DEFAULT 'with_branch',
  reason                text        NOT NULL,
  note                  text,
  late_exception_reason text,
  refund_total          numeric(12,2),                 -- fixed when the return is approved
  received_by           uuid        NOT NULL REFERENCES users(id),
  received_at           timestamptz NOT NULL DEFAULT now(),
  decided_by            uuid        REFERENCES users(id),
  decided_at            timestamptz,
  decision_reason       text,
  handed_back_to        text,
  handed_back_by        uuid        REFERENCES users(id),
  handed_back_at        timestamptz,
  idempotency_key_id    uuid        NOT NULL UNIQUE REFERENCES idempotency_keys(id),
  CONSTRAINT returns_status_valid CHECK (status IN ('in_custody', 'approved', 'rejected', 'handed_back')),
  CONSTRAINT returns_custody_valid CHECK (custody IN ('with_branch', 'customer_keeps')),
  CONSTRAINT returns_text_valid CHECK (length(reason) BETWEEN 3 AND 200 AND (note IS NULL OR length(note) <= 200) AND (late_exception_reason IS NULL OR length(late_exception_reason) BETWEEN 3 AND 200)),
  CONSTRAINT returns_decision_matches_status CHECK (
       (status IN ('in_custody') AND decided_by IS NULL AND decided_at IS NULL AND refund_total IS NULL)
    OR (status = 'approved' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND refund_total IS NOT NULL AND refund_total >= 0)
    OR (status IN ('rejected', 'handed_back') AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND refund_total IS NULL AND length(decision_reason) BETWEEN 3 AND 200)),
  CONSTRAINT returns_handback_matches_status CHECK (
       (status = 'handed_back' AND handed_back_to IS NOT NULL AND handed_back_by IS NOT NULL AND handed_back_at IS NOT NULL)
    OR (status <> 'handed_back' AND handed_back_to IS NULL AND handed_back_by IS NULL AND handed_back_at IS NULL))
);
CREATE INDEX ix_returns_sale ON returns (sale_id);
CREATE INDEX ix_returns_branch_received ON returns (receiving_branch_id, received_at DESC);

CREATE TABLE return_lines (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id     uuid          NOT NULL REFERENCES returns(id),
  sale_line_id  uuid          NOT NULL REFERENCES sale_lines(id),
  sku_id        uuid          NOT NULL REFERENCES skus(id),
  quantity      integer       NOT NULL,
  condition     text          NOT NULL,
  refund_value  numeric(12,2),                         -- the part of the refund of this line, fixed at approval
  released_qty  integer       NOT NULL DEFAULT 0,      -- how many were released from hold to sale
  CONSTRAINT return_lines_unique UNIQUE (return_id, sale_line_id),
  CONSTRAINT return_lines_quantity_valid CHECK (quantity > 0 AND released_qty >= 0 AND released_qty <= quantity),
  CONSTRAINT return_lines_condition_valid CHECK (condition IN ('as_new', 'minor_flaws', 'needs_repair', 'damaged')),
  CONSTRAINT return_lines_refund_valid CHECK (refund_value IS NULL OR refund_value >= 0)
);
CREATE INDEX ix_return_lines_sale_line ON return_lines (sale_line_id);

-- refund payments: cash or Whish, never more than the refund, never edited
CREATE TABLE return_refund_payments (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id        uuid          NOT NULL REFERENCES returns(id),
  method           text          NOT NULL,
  amount           numeric(12,2) NOT NULL,
  recipient        text          NOT NULL,
  reference        text,
  cash_session_id  uuid          REFERENCES cash_sessions(id),      -- a cash refund comes out of the drawer of the branch that paid it
  paid_by          uuid          NOT NULL REFERENCES users(id),
  paid_at          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT refund_payments_method_valid CHECK (method IN ('cash', 'whish')),
  CONSTRAINT refund_payments_amount_positive CHECK (amount > 0),
  CONSTRAINT refund_payments_recipient_valid CHECK (length(recipient) BETWEEN 2 AND 100 AND (reference IS NULL OR length(reference) BETWEEN 1 AND 64)),
  CONSTRAINT refund_payments_cash_only_in_session CHECK (method = 'cash' OR cash_session_id IS NULL)
);
CREATE INDEX ix_refund_payments_return ON return_refund_payments (return_id);
CREATE INDEX ix_refund_payments_session ON return_refund_payments (cash_session_id) WHERE cash_session_id IS NOT NULL;
CREATE TRIGGER trg_return_refund_payments_immutable BEFORE UPDATE OR DELETE ON return_refund_payments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- the ledger: two new movements, each linked to its return (the goods enter the hold once; the release is separate)
ALTER TABLE stock_movements ADD COLUMN return_id uuid REFERENCES returns(id);
CREATE INDEX ix_stock_movements_return ON stock_movements (return_id) WHERE return_id IS NOT NULL;
ALTER TABLE stock_movements DROP CONSTRAINT movements_type_valid;
ALTER TABLE stock_movements ADD CONSTRAINT movements_type_valid CHECK (movement_type = ANY (ARRAY['opening','sale','sale_reversal','return','transfer_dispatch','transfer_receipt','transfer_return','transfer_resolution','adjustment','goods_receipt','return_approval','return_release']));
ALTER TABLE stock_movements DROP CONSTRAINT movements_one_reference;
ALTER TABLE stock_movements ADD CONSTRAINT movements_one_reference CHECK (num_nonnulls(sale_id, transfer_id, adjustment_id, import_batch_id, goods_receipt_id, return_id) = 1);
ALTER TABLE stock_movements DROP CONSTRAINT movements_reference_matches_type;
ALTER TABLE stock_movements ADD CONSTRAINT movements_reference_matches_type CHECK (
     (movement_type = ANY (ARRAY['sale','sale_reversal','return']) AND sale_id IS NOT NULL)
  OR (movement_type = ANY (ARRAY['transfer_dispatch','transfer_receipt','transfer_return','transfer_resolution']) AND transfer_id IS NOT NULL)
  OR (movement_type = 'adjustment' AND adjustment_id IS NOT NULL)
  OR (movement_type = 'opening' AND import_batch_id IS NOT NULL)
  OR (movement_type = 'goods_receipt' AND goods_receipt_id IS NOT NULL)
  OR (movement_type = ANY (ARRAY['return_approval','return_release']) AND return_id IS NOT NULL)
);
