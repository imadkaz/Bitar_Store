-- 001_foundation.sql — Bitar Fashion Inventory & Replenishment MVP
-- The migration runner (scripts/migrate.ts) wraps this file in ONE transaction.
-- Do not put BEGIN/COMMIT in here.
--
-- Conventions
--   * Entities and documents: surrogate UUID primary key (gen_random_uuid()).
--     Pure link / 1:1 extension tables use a composite natural key.
--   * Quantities: INTEGER (whole units). Money: NUMERIC(12,2). Unit costs: NUMERIC(14,4).
--     No float/real/double/money types anywhere.
--   * Timestamps: timestamptz (UTC instants). Business day is stored as a date
--     computed in Asia/Beirut at posting time.
--   * Costs live ONLY in stock_costs and sale_line_costs so no SELECT * on a
--     business table can ever leak them (cost secrecy by construction).
--   * Text enums are CHECK constraints (easy to extend in later migrations).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------- helpers

CREATE SEQUENCE sale_ref_seq;
CREATE SEQUENCE transfer_ref_seq;
CREATE SEQUENCE adjustment_ref_seq;

CREATE FUNCTION touch_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version    := OLD.version + 1;   -- optimistic-concurrency token
  RETURN NEW;
END $$;

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: rows are immutable; post a compensating record instead',
    TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;

-- ---------------------------------------------------------------- identity & access

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  full_name      text NOT NULL,
  role           text NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  deactivated_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id),
  updated_by     uuid REFERENCES users(id),
  version        integer NOT NULL DEFAULT 1,
  CONSTRAINT users_role_valid      CHECK (role IN ('admin','manager','employee')),
  CONSTRAINT users_email_normal    CHECK (email = lower(btrim(email)) AND length(email) > 3),
  CONSTRAINT users_name_nonblank   CHECK (length(btrim(full_name)) > 0),
  CONSTRAINT users_deactivation_ok CHECK (is_active OR deactivated_at IS NOT NULL)
);
CREATE UNIQUE INDEX ux_users_email ON users (email);
-- Passwords/sessions belong to the auth library's own tables, linked by users.id.

CREATE TABLE branches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL,
  name       text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,   -- deactivate, never delete: history is preserved
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  updated_by uuid REFERENCES users(id),
  version    integer NOT NULL DEFAULT 1,
  CONSTRAINT branches_code_format CHECK (code = upper(btrim(code)) AND length(code) BETWEEN 1 AND 20),
  CONSTRAINT branches_name_nonblank CHECK (length(btrim(name)) > 0)
);
CREATE UNIQUE INDEX ux_branches_code ON branches (code);

CREATE TABLE user_branch_access (
  user_id    uuid NOT NULL REFERENCES users(id),
  branch_id  uuid NOT NULL REFERENCES branches(id),
  granted_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, branch_id)
);
CREATE INDEX ix_user_branch_access_branch ON user_branch_access (branch_id);

-- Individual allow/deny on top of role defaults. 'costs.view' is deliberately NOT
-- grantable: cost visibility is a function of role only (employees can never get it).
CREATE TABLE user_permission_overrides (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  permission text NOT NULL,
  effect     text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT upo_effect_valid CHECK (effect IN ('allow','deny')),
  CONSTRAINT upo_permission_valid CHECK (permission IN (
    'sales.create','discounts.apply','catalog.create','transfers.dispatch','transfers.receive',
    'returns.create','adjustments.create','reports.financial','users.administer')),
  CONSTRAINT ux_upo_user_permission UNIQUE (user_id, permission)
);

-- ---------------------------------------------------------------- catalog

CREATE TABLE styles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL,
  name       text NOT NULL,
  category   text,
  is_active  boolean NOT NULL DEFAULT true,   -- archive, never delete
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  updated_by uuid REFERENCES users(id),
  version    integer NOT NULL DEFAULT 1,
  CONSTRAINT styles_code_nonblank CHECK (length(btrim(code)) > 0 AND code = btrim(code)),
  CONSTRAINT styles_name_nonblank CHECK (length(btrim(name)) > 0)
);
CREATE UNIQUE INDEX ux_styles_code ON styles (code);
CREATE INDEX ix_styles_name_trgm ON styles USING gin (name gin_trgm_ops);

CREATE TABLE skus (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  style_id       uuid NOT NULL REFERENCES styles(id),
  sku_code       text NOT NULL,
  size           text NOT NULL,
  color          text NOT NULL,
  standard_price numeric(12,2) NOT NULL,
  currency       char(3) NOT NULL DEFAULT 'USD',
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id),
  updated_by     uuid REFERENCES users(id),
  version        integer NOT NULL DEFAULT 1,
  CONSTRAINT skus_code_nonblank  CHECK (length(btrim(sku_code)) > 0 AND sku_code = btrim(sku_code)),
  CONSTRAINT skus_size_nonblank  CHECK (length(btrim(size)) > 0),
  CONSTRAINT skus_color_nonblank CHECK (length(btrim(color)) > 0),
  CONSTRAINT skus_price_nonneg   CHECK (standard_price >= 0),
  CONSTRAINT skus_currency_fmt   CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE UNIQUE INDEX ux_skus_code    ON skus (sku_code);
CREATE UNIQUE INDEX ux_skus_variant ON skus (style_id, lower(btrim(size)), lower(btrim(color)));
CREATE INDEX ix_skus_code_trgm      ON skus USING gin (sku_code gin_trgm_ops);

CREATE TABLE sku_price_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id       uuid NOT NULL REFERENCES skus(id),
  old_price    numeric(12,2),
  new_price    numeric(12,2) NOT NULL CHECK (new_price >= 0),
  effective_at timestamptz NOT NULL DEFAULT now(),
  changed_by   uuid NOT NULL REFERENCES users(id)
);
CREATE INDEX ix_sku_price_history_sku ON sku_price_history (sku_id, effective_at DESC);

CREATE TABLE barcodes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id     uuid NOT NULL REFERENCES skus(id),
  code       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  CONSTRAINT barcodes_code_nonblank CHECK (length(code) > 0 AND code = btrim(code))
);
CREATE UNIQUE INDEX ux_barcodes_code ON barcodes (code);
CREATE INDEX ix_barcodes_sku ON barcodes (sku_id);

-- ---------------------------------------------------------------- idempotency

-- The claim row is inserted INSIDE the business transaction, so it commits (or rolls
-- back) atomically with the stock change. A committed row therefore always carries the
-- saved result. response_body must be the cost-free (employee-safe) DTO.
CREATE TABLE idempotency_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  operation       text NOT NULL,              -- 'sale.create', 'transfer.dispatch', ...
  idempotency_key text NOT NULL,
  request_hash    text NOT NULL,              -- sha256 hex of the canonical payload
  response_status smallint,
  response_body   jsonb,
  resource_type   text,
  resource_id     uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  CONSTRAINT idem_key_len  CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT idem_hash_fmt CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ux_idem_scope UNIQUE (user_id, operation, idempotency_key)
);

-- ---------------------------------------------------------------- stock

-- bucket: 'sellable'     = can be sold at this branch
--         'in_transit'   = dispatched TO this branch, not yet received (inbound; not sellable)
--         'non_sellable' = damaged / awaiting authorized resolution
CREATE TABLE stock_balances (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id     uuid NOT NULL REFERENCES skus(id),
  branch_id  uuid NOT NULL REFERENCES branches(id),
  bucket     text NOT NULL DEFAULT 'sellable',
  quantity   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version    integer NOT NULL DEFAULT 1,
  CONSTRAINT stock_balances_bucket_valid     CHECK (bucket IN ('sellable','in_transit','non_sellable')),
  CONSTRAINT stock_balances_quantity_nonneg  CHECK (quantity >= 0),   -- last line of defence for invariant #1
  CONSTRAINT ux_stock_balances_location      UNIQUE (sku_id, branch_id, bucket)
);
CREATE INDEX ix_stock_balances_branch_stocked
  ON stock_balances (branch_id, sku_id) WHERE bucket = 'sellable' AND quantity > 0;

-- Moving-average cost per branch/SKU. NULL = unknown (never treated as zero).
CREATE TABLE stock_costs (
  sku_id        uuid NOT NULL REFERENCES skus(id),
  branch_id     uuid NOT NULL REFERENCES branches(id),
  avg_unit_cost numeric(14,4),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sku_id, branch_id),
  CONSTRAINT stock_costs_nonneg CHECK (avg_unit_cost IS NULL OR avg_unit_cost >= 0)
);

CREATE TABLE adjustments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference          text NOT NULL DEFAULT ('A-' || lpad(nextval('adjustment_ref_seq')::text, 8, '0')),
  branch_id          uuid NOT NULL REFERENCES branches(id),
  sku_id             uuid NOT NULL REFERENCES skus(id),
  bucket             text NOT NULL DEFAULT 'sellable',
  quantity_delta     integer NOT NULL,
  reason             text NOT NULL,
  note               text NOT NULL,
  adjusted_by        uuid NOT NULL REFERENCES users(id),
  idempotency_key_id uuid NOT NULL UNIQUE REFERENCES idempotency_keys(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_adjustments_reference UNIQUE (reference),
  CONSTRAINT adjustments_bucket_valid CHECK (bucket IN ('sellable','in_transit','non_sellable')),
  CONSTRAINT adjustments_delta_nonzero CHECK (quantity_delta <> 0),
  CONSTRAINT adjustments_reason_valid CHECK (reason IN
    ('count_correction','damage','loss','found','data_entry_error','other')),
  CONSTRAINT adjustments_note_required CHECK (length(btrim(note)) >= 5)
);
CREATE INDEX ix_adjustments_branch_created ON adjustments (branch_id, created_at DESC);

CREATE TABLE sales (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference          text NOT NULL DEFAULT ('S-' || lpad(nextval('sale_ref_seq')::text, 8, '0')),
  branch_id          uuid NOT NULL REFERENCES branches(id),
  sold_by            uuid NOT NULL REFERENCES users(id),
  status             text NOT NULL DEFAULT 'completed',
  currency           char(3) NOT NULL DEFAULT 'USD',
  subtotal_standard  numeric(12,2) NOT NULL,
  total_discount     numeric(12,2) NOT NULL,
  total              numeric(12,2) NOT NULL,
  sold_at            timestamptz NOT NULL DEFAULT now(),
  business_date      date NOT NULL,            -- Asia/Beirut day, set at posting time
  idempotency_key_id uuid NOT NULL UNIQUE REFERENCES idempotency_keys(id),
  note               text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id),
  updated_by         uuid REFERENCES users(id),
  version            integer NOT NULL DEFAULT 1,
  CONSTRAINT ux_sales_reference UNIQUE (reference),
  CONSTRAINT sales_status_valid CHECK (status IN ('completed','partially_returned','returned','reversed')),
  CONSTRAINT sales_amounts_nonneg CHECK (subtotal_standard >= 0 AND total_discount >= 0 AND total >= 0),
  CONSTRAINT sales_totals_consistent CHECK (subtotal_standard - total_discount = total)
);
CREATE INDEX ix_sales_branch_day ON sales (branch_id, business_date);
CREATE INDEX ix_sales_sold_by    ON sales (sold_by, sold_at DESC);

CREATE TABLE sale_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id             uuid NOT NULL REFERENCES sales(id),
  line_no             smallint NOT NULL,
  sku_id              uuid NOT NULL REFERENCES skus(id),
  quantity            integer NOT NULL,
  unit_price_standard numeric(12,2) NOT NULL,    -- snapshot of the standard price at sale time
  reduction_type      text,
  reduction_percent   numeric(5,2),
  override_unit_price numeric(12,2),
  reduction_reason    text,
  reduced_by          uuid REFERENCES users(id),
  line_standard_total numeric(12,2) NOT NULL,
  line_total          numeric(12,2) NOT NULL,    -- rounded ONCE, half-up, to cents
  CONSTRAINT ux_sale_lines_no UNIQUE (sale_id, line_no),
  CONSTRAINT sale_lines_qty_positive CHECK (quantity > 0),
  CONSTRAINT sale_lines_amounts_ok CHECK (
    unit_price_standard >= 0 AND line_standard_total >= 0 AND line_total >= 0
    AND line_total <= line_standard_total),
  CONSTRAINT sale_lines_reduction_shape CHECK (
    (reduction_type IS NULL
       AND reduction_percent IS NULL AND override_unit_price IS NULL
       AND reduction_reason IS NULL  AND reduced_by IS NULL
       AND line_total = line_standard_total)
    OR (reduction_type = 'percent'
       AND reduction_percent > 0 AND reduction_percent <= 100
       AND override_unit_price IS NULL
       AND length(btrim(reduction_reason)) > 0 AND reduced_by IS NOT NULL)
    OR (reduction_type = 'override'
       AND override_unit_price IS NOT NULL AND override_unit_price <= unit_price_standard
       AND reduction_percent IS NULL
       AND length(btrim(reduction_reason)) > 0 AND reduced_by IS NOT NULL)
  )
);
CREATE INDEX ix_sale_lines_sale ON sale_lines (sale_id);
CREATE INDEX ix_sale_lines_sku  ON sale_lines (sku_id);

-- Cost snapshot at posting time. NULL = unknown cost (never zero).
CREATE TABLE sale_line_costs (
  sale_line_id       uuid PRIMARY KEY REFERENCES sale_lines(id),
  unit_cost_snapshot numeric(14,4),
  CONSTRAINT sale_line_costs_nonneg CHECK (unit_cost_snapshot IS NULL OR unit_cost_snapshot >= 0)
);

CREATE TABLE transfers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference             text NOT NULL DEFAULT ('T-' || lpad(nextval('transfer_ref_seq')::text, 8, '0')),
  source_branch_id      uuid NOT NULL REFERENCES branches(id),
  destination_branch_id uuid NOT NULL REFERENCES branches(id),
  status                text NOT NULL DEFAULT 'draft',
  requested_by          uuid NOT NULL REFERENCES users(id),
  requested_at          timestamptz NOT NULL DEFAULT now(),
  dispatched_by         uuid REFERENCES users(id),
  dispatched_at         timestamptz,
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES users(id),
  updated_by            uuid REFERENCES users(id),
  version               integer NOT NULL DEFAULT 1,
  CONSTRAINT ux_transfers_reference UNIQUE (reference),
  CONSTRAINT transfers_distinct_branches CHECK (source_branch_id <> destination_branch_id),
  CONSTRAINT transfers_status_valid CHECK (status IN
    ('draft','dispatched','partially_received','received','closed','cancelled')),
  CONSTRAINT transfers_dispatch_recorded CHECK (
    status IN ('draft','cancelled') OR (dispatched_at IS NOT NULL AND dispatched_by IS NOT NULL))
);
CREATE INDEX ix_transfers_source_open ON transfers (source_branch_id, status)
  WHERE status IN ('draft','dispatched','partially_received');
CREATE INDEX ix_transfers_dest_open ON transfers (destination_branch_id, status)
  WHERE status IN ('draft','dispatched','partially_received');

CREATE TABLE transfer_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id    uuid NOT NULL REFERENCES transfers(id),
  sku_id         uuid NOT NULL REFERENCES skus(id),
  requested_qty  integer NOT NULL,
  dispatched_qty integer NOT NULL DEFAULT 0,
  received_qty   integer NOT NULL DEFAULT 0,
  resolved_qty   integer NOT NULL DEFAULT 0,   -- shortage/damage/rejection explicitly resolved
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        integer NOT NULL DEFAULT 1,
  CONSTRAINT ux_transfer_lines_sku UNIQUE (transfer_id, sku_id),
  CONSTRAINT transfer_lines_requested_pos CHECK (requested_qty > 0),
  CONSTRAINT transfer_lines_nonneg CHECK (dispatched_qty >= 0 AND received_qty >= 0 AND resolved_qty >= 0),
  -- dispatched = received + in transit + resolved  =>  received + resolved can never exceed dispatched
  CONSTRAINT transfer_lines_quantities_consistent CHECK (
    dispatched_qty <= requested_qty AND received_qty + resolved_qty <= dispatched_qty)
);
CREATE INDEX ix_transfer_lines_sku ON transfer_lines (sku_id);

-- Immutable ledger. Every row names the request (idempotency key) that caused it.
-- import_batch_id has no FK yet: the opening-import migration adds import_batches + the FK.
CREATE TABLE stock_movements (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id               uuid NOT NULL REFERENCES skus(id),
  branch_id            uuid NOT NULL REFERENCES branches(id),
  bucket               text NOT NULL,
  movement_type        text NOT NULL,
  quantity_delta       integer NOT NULL,
  balance_after        integer NOT NULL,
  sale_id              uuid REFERENCES sales(id),
  transfer_id          uuid REFERENCES transfers(id),
  adjustment_id        uuid REFERENCES adjustments(id),
  import_batch_id      uuid,
  reverses_movement_id uuid REFERENCES stock_movements(id),
  reason               text,
  actor_user_id        uuid NOT NULL REFERENCES users(id),
  idempotency_key_id   uuid NOT NULL REFERENCES idempotency_keys(id),
  occurred_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT movements_bucket_valid CHECK (bucket IN ('sellable','in_transit','non_sellable')),
  CONSTRAINT movements_type_valid CHECK (movement_type IN
    ('opening','sale','sale_reversal','return','transfer_dispatch','transfer_receipt',
     'transfer_return','transfer_resolution','adjustment')),
  CONSTRAINT movements_delta_nonzero CHECK (quantity_delta <> 0),
  CONSTRAINT movements_balance_nonneg CHECK (balance_after >= 0),
  CONSTRAINT movements_sale_is_negative CHECK (movement_type <> 'sale' OR quantity_delta < 0),
  CONSTRAINT movements_one_reference CHECK (num_nonnulls(sale_id, transfer_id, adjustment_id, import_batch_id) = 1),
  CONSTRAINT movements_reference_matches_type CHECK (
       (movement_type IN ('sale','sale_reversal','return')                                   AND sale_id IS NOT NULL)
    OR (movement_type IN ('transfer_dispatch','transfer_receipt','transfer_return','transfer_resolution')
                                                                                             AND transfer_id IS NOT NULL)
    OR (movement_type = 'adjustment'                                                         AND adjustment_id IS NOT NULL)
    OR (movement_type = 'opening'                                                            AND import_batch_id IS NOT NULL))
);
CREATE INDEX ix_movements_location_time ON stock_movements (sku_id, branch_id, occurred_at DESC);
CREATE INDEX ix_movements_sale       ON stock_movements (sale_id)       WHERE sale_id IS NOT NULL;
CREATE INDEX ix_movements_transfer   ON stock_movements (transfer_id)   WHERE transfer_id IS NOT NULL;
CREATE INDEX ix_movements_adjustment ON stock_movements (adjustment_id) WHERE adjustment_id IS NOT NULL;
CREATE INDEX ix_movements_actor_time ON stock_movements (actor_user_id, occurred_at DESC);
CREATE INDEX ix_movements_idem       ON stock_movements (idempotency_key_id);
CREATE UNIQUE INDEX ux_movements_reversed_once
  ON stock_movements (reverses_movement_id) WHERE reverses_movement_id IS NOT NULL;

-- Blocked-operation alerts. Written in a SEPARATE transaction after the business
-- transaction rolls back (otherwise the rollback would erase the alert).
CREATE TABLE stock_alerts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type         text NOT NULL DEFAULT 'insufficient_stock',
  operation          text NOT NULL,
  branch_id          uuid NOT NULL REFERENCES branches(id),
  sku_id             uuid NOT NULL REFERENCES skus(id),
  requested_quantity integer NOT NULL CHECK (requested_quantity > 0),
  available_quantity integer NOT NULL CHECK (available_quantity >= 0),
  actor_user_id      uuid NOT NULL REFERENCES users(id),
  idempotency_key    text,
  request_id         text,
  acknowledged_by    uuid REFERENCES users(id),
  acknowledged_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_alerts_type_valid CHECK (alert_type IN ('insufficient_stock'))
);
CREATE INDEX ix_stock_alerts_open ON stock_alerts (created_at DESC) WHERE acknowledged_at IS NULL;
-- A client retrying the same blocked request must not spam the dashboard.
CREATE UNIQUE INDEX ux_stock_alerts_dedupe
  ON stock_alerts (actor_user_id, operation, idempotency_key, sku_id, branch_id)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------- triggers

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','branches','styles','skus','stock_balances',
                           'sales','transfers','transfer_lines'] LOOP
    EXECUTE format('CREATE TRIGGER trg_%1$s_touch BEFORE UPDATE ON %1$I
                    FOR EACH ROW EXECUTE FUNCTION touch_row()', t);
  END LOOP;
END $$;

CREATE TRIGGER trg_stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_stock_movements_no_truncate BEFORE TRUNCATE ON stock_movements
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_adjustments_immutable BEFORE UPDATE OR DELETE ON adjustments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- reconciliation

-- Invariant: balance = sum of posted movements. This view must ALWAYS be empty.
-- Run it after every integration test, before pilot opening, and daily during pilot.
CREATE VIEW v_stock_reconciliation_diffs AS
SELECT sku_id, branch_id, bucket,
       COALESCE(b.quantity, 0)  AS balance_qty,
       COALESCE(m.sum_delta, 0) AS movement_qty
FROM stock_balances b
FULL JOIN (
  SELECT sku_id, branch_id, bucket, SUM(quantity_delta)::int AS sum_delta
  FROM stock_movements GROUP BY sku_id, branch_id, bucket
) m USING (sku_id, branch_id, bucket)
WHERE COALESCE(b.quantity, 0) <> COALESCE(m.sum_delta, 0);
