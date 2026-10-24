CREATE TABLE user_credentials (
  user_id             uuid PRIMARY KEY REFERENCES users(id),
  password_hash       text NOT NULL,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_credentials_hash_nonblank CHECK (length(password_hash) > 0)
);