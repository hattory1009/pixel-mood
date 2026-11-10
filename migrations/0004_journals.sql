create table if not exists journals (
  user_id text primary key,
  payload text not null,
  updated_at timestamptz not null default now()
);
