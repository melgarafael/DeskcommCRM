-- manifest: **Campanha de texto pode sair em balões — `campaigns.split_messages boolean not null default false` (PR #3329, de @imcempreendimentos).** Ligada, a rodada parte o texto por parágrafo (linha em branco) com `splitForSend` do agente, até 3 balões por destinatário (o excedente vai junto no último), cada balão conta no `pacing_ledger` e o teto do número é conferido para os N balões antes de começar. Começa DESLIGADA: toda campanha existente segue em um balão só. Modelo aprovado (`message_mode = 'template'`) nunca se divide. Idempotente (`add column if not exists`); apêndice espelhado no fim do `baseline.sql`; `MANIFEST.md` é histórico e não recebe linha.

-- 0765 — campanha de texto em vários balões (PR #3329).
--
-- ─── Por que começa DESLIGADA ───────────────────────────────────────────────
-- Cada balão é uma mensagem física no número: três parágrafos viram três envios
-- e gastam três do teto do dia. Ligar por padrão triplicaria o consumo de toda
-- campanha que já existe sem ninguém ter pedido. Quem quer, liga no card
-- "Ritmo desta campanha".
--
-- ─── Compatibilidade ────────────────────────────────────────────────────────
-- `add column if not exists` + `default false`: linhas existentes ficam com o
-- comportamento de hoje, byte a byte.

alter table public.campaigns
  add column if not exists split_messages boolean not null default false;

comment on column public.campaigns.split_messages is
  'Campanha de texto sai em balões, um por parágrafo, até 3 por destinatário (PR #3329). Default false. Modelo aprovado nunca se divide.';
