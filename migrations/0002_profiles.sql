create table if not exists profiles (
  user_id text primary key,
  display_name text not null default '',
  avatar text,
  updated_at timestamptz not null default now()
);
