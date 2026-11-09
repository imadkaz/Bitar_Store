-- 016_transfer_completion.sql
-- Finishing the transfer (BL-02 and BL-03):
-- 1) holds: three more reasons for a stock adjustment: hold (put sellable pieces on hold), release (put held pieces back on sale) and
--    disposal (written off from the hold). The ledger and the audit keep who and why.
-- 2) a transfer BETWEEN TWO BRANCHES has two invoices: a RETURN invoice from the sending branch to the warehouse and a SALES invoice from
--    the warehouse to the receiving branch (the goods never enter the warehouse). A branch returning goods to the warehouse has the return invoice.
-- 3) the expected arrival date of a transfer, given when it is sent.
-- 4) the employees that exist keep the right to receive transfers (BL-03: confirming an arrival is a manager's act, so it is no longer part of the
--    DEFAULT of a new employee; it is granted).

ALTER TABLE invoices DROP CONSTRAINT invoices_kind_valid;
ALTER TABLE invoices ADD CONSTRAINT invoices_kind_valid CHECK (kind IN ('b2b', 'b2b_return', 'b2c'));
ALTER TABLE invoices DROP CONSTRAINT invoices_source_matches_kind;
ALTER TABLE invoices ADD CONSTRAINT invoices_source_matches_kind CHECK (
     (kind IN ('b2b', 'b2b_return') AND transfer_id IS NOT NULL AND sale_id IS NULL AND recipient_branch_id IS NOT NULL)
  OR (kind = 'b2c' AND sale_id IS NOT NULL AND transfer_id IS NULL));
DROP INDEX ux_invoices_transfer_live;
-- one live invoice of each KIND per transfer (a void one does not count)
CREATE UNIQUE INDEX ux_invoices_transfer_live ON invoices (transfer_id, kind) WHERE transfer_id IS NOT NULL AND status <> 'void';
CREATE SEQUENCE invoice_b2b_return_ref_seq;

ALTER TABLE adjustments DROP CONSTRAINT adjustments_reason_valid;
ALTER TABLE adjustments ADD CONSTRAINT adjustments_reason_valid CHECK (reason IN
  ('count_correction', 'damage', 'loss', 'found', 'data_entry_error', 'other', 'hold', 'release', 'disposal'));

ALTER TABLE transfers ADD COLUMN expected_at timestamptz;

INSERT INTO user_permission_overrides (user_id, permission, effect)
SELECT id, 'transfers.receive', 'allow' FROM users WHERE role = 'employee' AND deleted_at IS NULL
ON CONFLICT (user_id, permission) DO NOTHING;
