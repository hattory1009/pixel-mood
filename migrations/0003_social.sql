create table if not exists friendships (
  id text primary key,
  requester_id text not null,
  addressee_id text not null,
  status text not null,
  created_at timestamptz not null default now(),
  unique (requester_id, addressee_id)
);

create index if not exists friendships_addressee_idx on friendships (addressee_id);

create table if not exists messages (
  id text primary key,
  sender_id text not null,
  recipient_id text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists messages_pair_idx on messages (sender_id, recipient_id, created_at);
