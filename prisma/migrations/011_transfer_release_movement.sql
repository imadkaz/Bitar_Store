-- Release from inspection hold to sellable after transfer receive.
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS movements_type_valid;
ALTER TABLE stock_movements ADD CONSTRAINT movements_type_valid CHECK (movement_type IN (
  'opening','sale','sale_reversal','return','transfer_dispatch','transfer_receipt','transfer_release',
  'transfer_return','transfer_resolution','adjustment','goods_receipt'
));

ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS movements_reference_matches_type;
ALTER TABLE stock_movements ADD CONSTRAINT movements_reference_matches_type CHECK (
     (movement_type IN ('sale','sale_reversal','return') AND sale_id IS NOT NULL)
  OR (movement_type IN ('transfer_dispatch','transfer_receipt','transfer_release','transfer_return','transfer_resolution')
      AND transfer_id IS NOT NULL)
  OR (movement_type = 'adjustment' AND adjustment_id IS NOT NULL)
  OR (movement_type = 'opening' AND import_batch_id IS NOT NULL)
  OR (movement_type = 'goods_receipt' AND goods_receipt_id IS NOT NULL)
);
