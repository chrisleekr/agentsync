-- Seed data for local development.
CREATE TABLE IF NOT EXISTS users (
  id bigint generated always as identity primary key,
  name text not null,
  created_at timestamptz not null default now()
);

INSERT INTO users (name) VALUES ('alice');
INSERT INTO users (name) VALUES ('bob');
INSERT INTO users (name) VALUES ('carol');
INSERT INTO users (name) VALUES ('dave');
