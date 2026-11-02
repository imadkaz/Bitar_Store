-- 005_categories_and_soft_delete.sql
-- 1) Categories become a list the owner manages (add, rename, delete), not free text typed on each product.
-- 2) A deleted user disappears from the system but everything they did stays (sales, movements, transfers).

CREATE TABLE categories (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid        REFERENCES users(id),
  updated_by uuid        REFERENCES users(id),
  version    integer     NOT NULL DEFAULT 1,
  CONSTRAINT categories_name_valid  CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 60),
  CONSTRAINT categories_name_unique UNIQUE (name)
);
-- "Dresses" and "dresses" are the same category
CREATE UNIQUE INDEX ux_categories_name_ci ON categories (lower(name));
CREATE TRIGGER trg_categories_touch BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION touch_row();

-- the categories already typed on products become the first list (one spelling per name)
INSERT INTO categories (name)
SELECT DISTINCT ON (lower(btrim(category))) btrim(category)
FROM styles WHERE category IS NOT NULL AND btrim(category) <> ''
ORDER BY lower(btrim(category)), btrim(category);
UPDATE styles s SET category = c.name FROM categories c WHERE s.category IS NOT NULL AND lower(btrim(s.category)) = lower(c.name);
UPDATE styles SET category = NULL WHERE category IS NOT NULL AND btrim(category) = '';

-- a product's category must exist in the list. Renaming a category renames it on its products; a category in use cannot be deleted.
ALTER TABLE styles
  ADD CONSTRAINT styles_category_fk FOREIGN KEY (category) REFERENCES categories(name) ON UPDATE CASCADE ON DELETE RESTRICT;

-- soft delete of users
ALTER TABLE users ADD COLUMN deleted_at timestamptz;
ALTER TABLE users ADD CONSTRAINT users_deleted_is_inactive CHECK (deleted_at IS NULL OR (NOT is_active AND password_hash IS NULL));
CREATE INDEX ix_users_not_deleted ON users (created_at) WHERE deleted_at IS NULL;
