-- 004_locations_reorder_audit.sql
-- Owner decisions (29 Oct): the warehouse is the main inventory that supplies the branches; it does not sell to customers.
-- The admin sees every location, a manager only the branches granted to them. The minimum stock is set per branch and per sku.

-- 1) What kind of place a "branch" row is. The table keeps its name: one stock table and one transfer logic serve both.
ALTER TABLE branches
  ADD COLUMN kind text NOT NULL DEFAULT 'branch',
  ADD CONSTRAINT branches_kind_valid CHECK (kind IN ('branch', 'warehouse'));

-- there is ONE main inventory
CREATE UNIQUE INDEX ux_branches_one_warehouse ON branches (kind) WHERE kind = 'warehouse';

-- 2) The minimum a branch should keep of a sku. Below it, the warehouse is told to send more.
CREATE TABLE reorder_levels (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id          uuid        NOT NULL REFERENCES skus(id),
  branch_id       uuid        NOT NULL REFERENCES branches(id),
  min_quantity    integer     NOT NULL,
  target_quantity integer,                     -- fill back up to this quantity; NULL means "up to the minimum"
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid        REFERENCES users(id),
  updated_by      uuid        REFERENCES users(id),
  version         integer     NOT NULL DEFAULT 1,
  CONSTRAINT reorder_levels_min_nonneg CHECK (min_quantity >= 0),
  CONSTRAINT reorder_levels_target_valid CHECK (target_quantity IS NULL OR target_quantity >= min_quantity),
  CONSTRAINT reorder_levels_one_per_sku_branch UNIQUE (sku_id, branch_id)
);
CREATE INDEX ix_reorder_levels_branch ON reorder_levels (branch_id);
CREATE TRIGGER trg_reorder_levels_touch BEFORE UPDATE ON reorder_levels
  FOR EACH ROW EXECUTE FUNCTION touch_row();

-- 3) The database has the last word on the warehouse rules (the application checks them first, with friendly messages).
CREATE FUNCTION forbid_warehouse_rows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT kind FROM branches WHERE id = NEW.branch_id) = 'warehouse' THEN
    RAISE EXCEPTION 'the warehouse cannot have rows in %: it supplies the branches, it does not sell to customers', TG_TABLE_NAME
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_sales_not_at_warehouse BEFORE INSERT ON sales
  FOR EACH ROW EXECUTE FUNCTION forbid_warehouse_rows();
CREATE TRIGGER trg_reorder_levels_not_at_warehouse BEFORE INSERT OR UPDATE OF branch_id ON reorder_levels
  FOR EACH ROW EXECUTE FUNCTION forbid_warehouse_rows();

-- a place that already sold to customers, or has a minimum set, cannot turn into the warehouse
CREATE FUNCTION forbid_warehouse_with_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'warehouse' AND OLD.kind <> 'warehouse'
     AND (EXISTS (SELECT 1 FROM sales WHERE branch_id = NEW.id) OR EXISTS (SELECT 1 FROM reorder_levels WHERE branch_id = NEW.id)) THEN
    RAISE EXCEPTION 'branch % already has sales or minimum levels: it cannot become the warehouse', NEW.code
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_branches_kind_change BEFORE UPDATE OF kind ON branches
  FOR EACH ROW EXECUTE FUNCTION forbid_warehouse_with_history();

-- 4) Who did what, and when. Append-only: a correction is a new event, never an edit.
CREATE TABLE audit_events (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid        NOT NULL REFERENCES users(id),
  action        text        NOT NULL,          -- "entity.verb", for example reorder_level.set
  entity_type   text        NOT NULL,
  entity_id     uuid,
  branch_id     uuid        REFERENCES branches(id),
  details       jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- the values before and after, the reason
  CONSTRAINT audit_events_action_format CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  CONSTRAINT audit_events_entity_type_format CHECK (entity_type ~ '^[a-z_]+$'),
  CONSTRAINT audit_events_details_object CHECK (jsonb_typeof(details) = 'object')
);
CREATE INDEX ix_audit_events_time ON audit_events (occurred_at DESC);
CREATE INDEX ix_audit_events_entity ON audit_events (entity_type, entity_id);
CREATE INDEX ix_audit_events_actor ON audit_events (actor_user_id, occurred_at DESC);
CREATE INDEX ix_audit_events_branch ON audit_events (branch_id, occurred_at DESC) WHERE branch_id IS NOT NULL;

CREATE TRIGGER trg_audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();