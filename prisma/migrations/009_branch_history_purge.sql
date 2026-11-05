-- A branch deletion is an explicit admin operation that may purge otherwise immutable history.
-- Keep this exception transaction-scoped so the normal immutability rules remain in force.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_branch_history_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% on % is not allowed: rows are immutable; post a compensating record instead',
    TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;

CREATE OR REPLACE FUNCTION invoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_branch_history_purge', true) = 'on' THEN RETURN OLD; END IF;
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

CREATE OR REPLACE FUNCTION invoice_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent text;
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_branch_history_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  SELECT status INTO parent FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF parent IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'The lines of an invoice change only while it is a draft' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
