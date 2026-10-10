-- 0087 — `provider` em channel_sessions: o canal deixa de ser suposto.
--
-- Até aqui o sistema INTEIRO supunha WAHA: o handler de envio chamava
-- `getAdapter("waha")` com literal, e o ctx de produção do `before_send` fixava
-- `provider: 'waha'`. Os dois literais foram deixados pelas Tasks 4b/5 do plano
-- do seam de canais apontando para esta migration — porque um literal é honesto
-- enquanto a coluna não existe, e vira mentira no dia em que existir.
--
-- Tagged union, não flag: `provider` sozinho aceitaria uma sessão `meta_cloud`
-- sem `meta_phone_number_id` e uma sessão `waha` sem `waha_session_name` — as
-- duas irresolvíveis na hora do envio, descobertas em runtime, com a mensagem
-- do cliente já aceita. O CHECK move a descoberta para o INSERT.
--
-- `waha_session_name` perde o NOT NULL porque ele É o identificador de UM dos
-- ramos da união; mantê-lo obrigatório tornaria `meta_cloud` inexprimível. A
-- UNIQUE dele continua valendo (NULLs são distintos entre si no Postgres, então
-- N sessões meta_cloud convivem).
--
-- ⚠️ O QUE ESTA MIGRATION **NÃO** FAZ, de propósito: não cria índice único de
-- (organization_id, phone_number). O plano pedia
-- `channel_sessions_org_phone_uniq`, mas a trava JÁ EXISTE desde o snapshot
-- original — `channel_sessions_phone_per_org_unique UNIQUE (organization_id,
-- phone_number) DEFERRABLE INITIALLY DEFERRED` — e ela já responde ao invariante
-- pedido ("um número vive em UM provider"), porque não olha o provider: o par
-- (org, número) é único, ponto. Criar o índice seria duplicar a checagem em toda
-- escrita e, pior, ADICIONAR uma trava NÃO-deferível ao lado de uma deferível:
-- qualquer transação que hoje troca números entre duas sessões (permitida, e é
-- exatamente por isso que alguém a fez DEFERRABLE) passaria a falhar no meio.
-- Ver `tests/invariants/channel-provider-schema.test.ts`, que cobra a trava pelo
-- nome real.
--
-- Backfill: nenhum é necessário, e isso é por construção, não por sorte. O
-- default preenche as linhas existentes com 'waha' no mesmo ALTER, e
-- `waha_session_name` era NOT NULL até esta migration — então TODA linha
-- pré-existente satisfaz o ramo 'waha' da união antes do CHECK nascer. Vale para
-- qualquer clone, não só para este banco.

alter table public.channel_sessions
  add column if not exists provider text not null default 'waha',
  add column if not exists meta_phone_number_id text,
  add column if not exists meta_waba_id text,
  add column if not exists meta_token_encrypted bytea;

alter table public.channel_sessions alter column waha_session_name drop not null;

do $$ begin
  alter table public.channel_sessions add constraint channel_sessions_provider_check
    check (provider = any (array['waha'::text, 'meta_cloud'::text]));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.channel_sessions add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name    is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null)
  );
exception when duplicate_object then null; end $$;

comment on column public.channel_sessions.provider is
  'Canal desta sessão. Vocabulário espelhado em lib/channels/types.ts → ChannelProvider (cobrado por tests/invariants/vocabulario-banco-x-typescript.test.ts).';
