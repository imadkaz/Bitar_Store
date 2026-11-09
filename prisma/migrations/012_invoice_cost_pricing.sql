-- 012_invoice_cost_pricing.sql
-- A SUPPLY invoice (warehouse to branch) is priced at what the goods COST the business, not at the price the branch sells them for.
-- Each invoice line remembers where its price came from, so the warehouse can see which lines still need a price:
--   cost    = the average purchase cost kept at the warehouse (stock_costs), filled by every goods receipt
--   missing = no cost is known yet (for example opening stock): the price is 0 until someone sets it
--   manual  = the warehouse typed it while the invoice was a draft
--   sale    = the invoice of a sale (the price the customer paid)
-- NULL = an invoice made before this migration (priced from the catalog).
ALTER TABLE invoice_lines ADD COLUMN price_source text;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_price_source_valid CHECK (price_source IS NULL OR price_source IN ('cost', 'missing', 'manual', 'sale'));
