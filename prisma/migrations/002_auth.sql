-- 002_auth.sql: login password hash, stored on users.
-- Nullable on purpose: a user can exist before login is switched on; NULL means "cannot log in".
-- The application never loads this column except when checking a login (see UserRepository: every query omits it).
ALTER TABLE users ADD COLUMN password_hash text;
ALTER TABLE users ADD CONSTRAINT users_password_hash_nonblank CHECK (password_hash IS NULL OR length(password_hash) > 0);
