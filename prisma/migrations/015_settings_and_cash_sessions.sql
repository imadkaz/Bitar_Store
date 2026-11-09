-- 015_settings_and_cash_sessions.sql
-- 1) SETTINGS the managers keep for the whole business (exchange rate, return period, reservation days, and whether a sale needs an open cash session).
-- 2) CASH SESSIONS (approved "Cash Sessions and Payments" 28 Oct): one drawer and at most one open session per branch, counted opening cash,
--    cash movements outside sales, a counted handover when responsibility changes, a closing with the difference explained, and a locked
--    closed session that only a manager can correct (linked corrections, the original closing is never changed).
-- 3) four new permissions: cash.open, cash.accept, cash.close, cash.move.

-- ---- permissions
ALTER TABLE user_permission_overrides DROP CONSTRAINT upo_permission_valid;
ALTER TABLE user_permission_overrides ADD CONSTRAINT upo_permission_valid CHECK (permission IN (
  'sales.create','discounts.apply','catalog.create','transfers.dispatch','transfers.receive',
  'returns.create','adjustments.create','reports.financial','users.administer',
  'cash.open','cash.accept','cash.close','cash.move'));

-- ---- settings
CREATE TABLE settings (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_by uuid        REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settings_key_valid CHECK (key ~ '^[a-zA-Z][a-zA-Z0-9]{1,60}$')
);

-- ---- cash sessions
CREATE SEQUENCE cash_session_ref_seq;
CREATE TABLE cash_sessions (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           text          NOT NULL DEFAULT ('CS-' || lpad(nextval('cash_session_ref_seq')::text, 8, '0')),
  branch_id           uuid          NOT NULL REFERENCES branches(id),
  status              text          NOT NULL DEFAULT 'open',
  opened_by           uuid          NOT NULL REFERENCES users(id),
  opened_at           timestamptz   NOT NULL DEFAULT now(),
  opening_cash        numeric(12,2) NOT NULL,
  expected_opening    numeric(12,2),                -- what the previous session left in the drawer (NULL for the first session of a branch)
  opening_note        text,
  responsible_user_id uuid          NOT NULL REFERENCES users(id),
  closed_by           uuid          REFERENCES users(id),
  closed_at           timestamptz,
  expected_cash       numeric(12,2),                -- at the closing
  counted_cash        numeric(12,2),
  difference          numeric(12,2),                -- counted - expected
  difference_note     text,
  cash_removed        numeric(12,2),
  cash_left           numeric(12,2),
  late_closed         boolean       NOT NULL DEFAULT false,
  review_status       text          NOT NULL DEFAULT 'none',
  reviewed_by         uuid          REFERENCES users(id),
  reviewed_at         timestamptz,
  review_note         text,
  CONSTRAINT cash_sessions_status_valid CHECK (status IN ('open', 'closed')),
  CONSTRAINT cash_sessions_review_valid CHECK (review_status IN ('none', 'flagged', 'reviewed')),
  CONSTRAINT cash_sessions_amounts_valid CHECK (opening_cash >= 0 AND (counted_cash IS NULL OR counted_cash >= 0) AND (cash_removed IS NULL OR cash_removed >= 0) AND (cash_left IS NULL OR cash_left >= 0)),
  CONSTRAINT cash_sessions_closing_matches_status CHECK (
       (status = 'open'   AND closed_by IS NULL AND closed_at IS NULL AND counted_cash IS NULL AND expected_cash IS NULL AND difference IS NULL AND cash_removed IS NULL AND cash_left IS NULL)
    OR (status = 'closed' AND closed_by IS NOT NULL AND closed_at IS NOT NULL AND counted_cash IS NOT NULL AND expected_cash IS NOT NULL AND difference IS NOT NULL AND cash_removed IS NOT NULL AND cash_left IS NOT NULL
        AND cash_removed + cash_left = counted_cash AND difference = counted_cash - expected_cash)),
  CONSTRAINT cash_sessions_difference_explained CHECK (difference IS NULL OR difference = 0 OR (difference_note IS NOT NULL AND length(difference_note) BETWEEN 3 AND 200)),
  CONSTRAINT cash_sessions_notes_valid CHECK ((opening_note IS NULL OR length(opening_note) <= 200) AND (review_note IS NULL OR length(review_note) <= 200))
);
-- ONE open session per branch: the second one is refused by the database
CREATE UNIQUE INDEX ux_cash_sessions_one_open ON cash_sessions (branch_id) WHERE status = 'open';
CREATE INDEX ix_cash_sessions_branch_opened ON cash_sessions (branch_id, opened_at DESC);

-- a closed session is locked: only the manager's review can change (the review columns); an open one can only be closed, never reopened
CREATE FUNCTION cash_sessions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A cash session cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF OLD.status = 'closed' THEN
    IF (to_jsonb(NEW) - ARRAY['review_status','reviewed_by','reviewed_at','review_note']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['review_status','reviewed_by','reviewed_at','review_note']) THEN
      RAISE EXCEPTION 'A closed cash session is locked: add a linked correction instead' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.status = 'open' AND (NEW.branch_id <> OLD.branch_id OR NEW.opening_cash <> OLD.opening_cash OR NEW.opened_by <> OLD.opened_by OR NEW.opened_at <> OLD.opened_at) THEN
    RAISE EXCEPTION 'The opening of a cash session does not change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_cash_sessions_guard BEFORE UPDATE OR DELETE ON cash_sessions FOR EACH ROW EXECUTE FUNCTION cash_sessions_guard();

-- cash in or out, outside the sales: amount, direction, reason, who, when
CREATE TABLE cash_movements (
  id         uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid          NOT NULL REFERENCES cash_sessions(id),
  direction  text          NOT NULL,
  amount     numeric(12,2) NOT NULL,
  reason     text          NOT NULL,
  created_by uuid          NOT NULL REFERENCES users(id),
  created_at timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT cash_movements_direction_valid CHECK (direction IN ('in', 'out')),
  CONSTRAINT cash_movements_amount_positive CHECK (amount > 0),
  CONSTRAINT cash_movements_reason_valid CHECK (length(reason) BETWEEN 3 AND 200)
);
CREATE INDEX ix_cash_movements_session ON cash_movements (session_id, created_at);

-- a counted handover: who gives, who takes, the count, what was expected, the difference
CREATE TABLE cash_handovers (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid          NOT NULL REFERENCES cash_sessions(id),
  outgoing_user_id uuid          NOT NULL REFERENCES users(id),
  incoming_user_id uuid          NOT NULL REFERENCES users(id),
  counted_cash     numeric(12,2) NOT NULL,
  expected_cash    numeric(12,2) NOT NULL,
  difference       numeric(12,2) NOT NULL,
  note             text,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT cash_handovers_people_differ CHECK (outgoing_user_id <> incoming_user_id),
  CONSTRAINT cash_handovers_amounts_valid CHECK (counted_cash >= 0 AND difference = counted_cash - expected_cash),
  CONSTRAINT cash_handovers_difference_explained CHECK (difference = 0 OR (note IS NOT NULL AND length(note) BETWEEN 3 AND 200))
);
CREATE INDEX ix_cash_handovers_session ON cash_handovers (session_id, created_at);

-- a manager's correction of a CLOSED session: the closing stays as it was, the correction sits beside it
CREATE TABLE cash_session_corrections (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid          NOT NULL REFERENCES cash_sessions(id),
  field        text          NOT NULL,
  value_before numeric(12,2) NOT NULL,
  value_after  numeric(12,2) NOT NULL,
  reason       text          NOT NULL,
  corrected_by uuid          NOT NULL REFERENCES users(id),
  created_at   timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT cash_corrections_field_valid CHECK (field IN ('opening_cash', 'counted_cash', 'cash_removed')),
  CONSTRAINT cash_corrections_amount_valid CHECK (value_before >= 0 AND value_after >= 0 AND value_after <> value_before),
  CONSTRAINT cash_corrections_reason_valid CHECK (length(reason) BETWEEN 3 AND 200)
);
CREATE INDEX ix_cash_corrections_session ON cash_session_corrections (session_id, created_at);

CREATE TRIGGER trg_cash_movements_immutable BEFORE UPDATE OR DELETE ON cash_movements FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_cash_handovers_immutable BEFORE UPDATE OR DELETE ON cash_handovers FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_cash_corrections_immutable BEFORE UPDATE OR DELETE ON cash_session_corrections FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- every sale records the session it was made in (NULL: made before sessions existed, or while sessions are not required)
ALTER TABLE sales ADD COLUMN cash_session_id uuid REFERENCES cash_sessions(id);
CREATE INDEX ix_sales_cash_session ON sales (cash_session_id) WHERE cash_session_id IS NOT NULL;
