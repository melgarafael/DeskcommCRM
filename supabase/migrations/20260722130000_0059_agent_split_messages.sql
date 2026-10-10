-- 0059: split de mensagens por-agente (Onda 4). split_messages liga o
-- comportamento; split_max_chars é o teto por bolha antes de quebrar.
alter table ai_agent_versions
  add column if not exists split_messages boolean not null default false,
  add column if not exists split_max_chars integer not null default 600;
