-- Received good units stay on hold until explicitly released to sellable.
ALTER TABLE transfer_lines
  ADD COLUMN IF NOT EXISTS damaged_qty INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS released_qty INT NOT NULL DEFAULT 0;

-- Transfers received before this workflow already moved good stock to sellable.
UPDATE transfer_lines
SET released_qty = GREATEST(0, received_qty - damaged_qty)
WHERE released_qty = 0 AND received_qty > 0;
