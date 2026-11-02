-- 006_manager_all_branches.sql
-- A manager can be appointed to every branch (they move between Saida, Tripoli, Hamra...) instead of a list of branches.
-- The flag is read on every request, so a branch created tomorrow is included without touching the manager.
ALTER TABLE users ADD COLUMN all_branches boolean NOT NULL DEFAULT false;
