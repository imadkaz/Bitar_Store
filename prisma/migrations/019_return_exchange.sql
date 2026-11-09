-- 019_return_exchange.sql
-- An EXCHANGE (BL-04) is a linked return plus a new sale. The new sale is linked to the approved return; the net amount is kept:
-- positive = the customer pays that much more, negative = the business owes the customer that much. The returned goods follow the custody and hold rules as always.
ALTER TABLE returns
  ADD COLUMN exchange_sale_id uuid UNIQUE REFERENCES sales(id),
  ADD COLUMN exchange_net     numeric(12,2),
  ADD COLUMN exchange_linked_by uuid REFERENCES users(id),
  ADD COLUMN exchange_linked_at timestamptz;
ALTER TABLE returns ADD CONSTRAINT returns_exchange_complete CHECK (
     (exchange_sale_id IS NULL AND exchange_net IS NULL AND exchange_linked_by IS NULL AND exchange_linked_at IS NULL)
  OR (exchange_sale_id IS NOT NULL AND exchange_net IS NOT NULL AND exchange_linked_by IS NOT NULL AND exchange_linked_at IS NOT NULL AND status = 'approved'));
