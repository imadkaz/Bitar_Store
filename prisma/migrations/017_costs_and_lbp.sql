-- 017_costs_and_lbp.sql
-- 1) The COST of what is sold is kept on the day of the sale (sale_line_costs, which already existed and was empty), so profit never changes when costs change later.
--    The cost of a piece = the average cost kept at the warehouse; if none, the catalog cost a manager typed (catalog_costs). Unknown stays unknown (NULL), never zero.
--    Costs live in tables of their own so no SELECT on a business table can leak them.
-- 2) PAYING IN POUNDS (LBP). Prices stay in dollars. A cash payment can be in LBP (the dollar amount it pays is kept, with the pounds received and the rate used); a part of the
--    change can be given in LBP. The rate of the sale is kept on the sale and on its invoice, so the old ones never change when the rate changes. Whish is dollars only.

CREATE TABLE catalog_costs (
  sku_id     uuid          PRIMARY KEY REFERENCES skus(id),
  unit_cost  numeric(14,4) NOT NULL,
  updated_by uuid          REFERENCES users(id),
  updated_at timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT catalog_costs_nonneg CHECK (unit_cost >= 0)
);

ALTER TABLE sale_line_costs ADD COLUMN source text;
ALTER TABLE sale_line_costs ADD CONSTRAINT sale_line_costs_source_valid CHECK ((unit_cost_snapshot IS NULL AND source IS NULL) OR (unit_cost_snapshot IS NOT NULL AND source IN ('warehouse', 'catalog')));
CREATE TRIGGER trg_sale_line_costs_immutable BEFORE UPDATE OR DELETE ON sale_line_costs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE sale_payments
  ADD COLUMN currency       text          NOT NULL DEFAULT 'USD',
  ADD COLUMN lbp_amount     bigint,                              -- LBP payments: the pounds received for this payment's dollar amount
  ADD COLUMN exchange_rate  integer,                             -- the rate (LBP for one dollar) used for the pounds of this payment or of its change
  ADD COLUMN change_lbp_usd numeric(12,2) NOT NULL DEFAULT 0,    -- cash USD payments: the part of the change (in dollars) that was given back in pounds
  ADD COLUMN change_lbp     bigint;                              -- ... and those pounds
ALTER TABLE sale_payments ADD CONSTRAINT sale_payments_currency_valid CHECK (currency IN ('USD', 'LBP'));
ALTER TABLE sale_payments ADD CONSTRAINT sale_payments_lbp_shape CHECK (
     (currency = 'USD' AND lbp_amount IS NULL)
  OR (currency = 'LBP' AND method = 'cash' AND lbp_amount > 0 AND exchange_rate IS NOT NULL AND cash_tendered = amount AND change_lbp_usd = 0 AND change_lbp IS NULL));
ALTER TABLE sale_payments ADD CONSTRAINT sale_payments_change_lbp_shape CHECK (
     (change_lbp_usd = 0 AND change_lbp IS NULL)
  OR (method = 'cash' AND currency = 'USD' AND change_lbp_usd > 0 AND change_lbp > 0 AND exchange_rate IS NOT NULL AND change_lbp_usd <= cash_tendered - amount));

ALTER TABLE sales    ADD COLUMN exchange_rate integer, ADD COLUMN total_lbp bigint;     -- the rate of the day of the sale and the total in pounds at that rate (NULL when no rate was set)
ALTER TABLE invoices ADD COLUMN exchange_rate integer, ADD COLUMN total_lbp bigint;     -- copied from the sale onto the invoice of a sale
