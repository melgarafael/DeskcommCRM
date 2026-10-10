-- 0163 — O ARQUIVO DO WEBHOOK PODE PERDER O CORPO, E DIZER QUANDO PERDEU.
--
-- `webhook_events_log` guarda o payload cru de todo webhook que entra. É o
-- instrumento que responde perguntas que nenhum log estruturado responde — foi
-- ele que permitiu decidir sobre as identidades opacas (`@lid`) contando "76 de
-- 76" no banco. Ninguém quer perdê-lo.
--
-- O problema é que ele nunca é podado. Medido numa instalação real em 20/08/2026:
--
--   banco inteiro ............ 545 MB
--   webhook_events_log ....... 468 MB  (86%)
--   messages ................. 3,2 MB
--
-- Nenhuma linha com mais de 30 dias — as 56.291 são de 20 dias. Cresce ~23 MB
-- por dia, ~700 MB por mês, para sempre. O teto do plano gratuito do Supabase é
-- 500 MB, e é onde a maioria dos clones vive.
--
-- ─── Por que ESVAZIAR o corpo em vez de apagar a linha ──────────────────────
--
-- Apagar responderia ao espaço e mataria o instrumento: "quantos eventos de que
-- tipo chegaram, quando, e a assinatura conferia?" deixa de ter resposta. E é
-- essa a pergunta que o arquivo existe para responder depois do incidente.
--
-- As três colunas pesadas (`raw_body`, `payload_parsed`, `headers`) são ~97% do
-- peso; a linha sem elas custa ~200 B. Esvaziar guarda o índice forense inteiro
-- (provider, tipo, id externo, horário, assinatura, desfecho) por ~11 MB.
--
-- ─── Por que `raw_body` precisa aceitar NULL ────────────────────────────────
--
-- Ela nasceu `not null`, o que é certo para quem ESCREVE: um arquivo que aceita
-- linha sem corpo aceitaria o bug de gravar vazio. Mas então não há como marcar
-- "o corpo existiu e foi descartado" sem mentir — string vazia se confunde com
-- corpo vazio de verdade, que é um caso real (webhook de ping).
--
-- NULL diz "não está aqui", e `archived_at` diz desde quando. Medido antes de
-- afrouxar: NENHUM leitor consulta `raw_body` — os 7 aciertos no repositório são
-- todos INSERT, e a única tela que lê o arquivo
-- (`app/api/v1/webhook-sources/[id]/events`) pede `payload_parsed`, não o cru.
--
-- ─── `archived_at` já existia, e não tinha dono ─────────────────────────────
--
-- A coluna está na tabela desde sempre e NENHUM código a escreve ou lê (medido:
-- 0 linhas com valor em 56.350). Era promessa de esqueleto — o anti-pattern nº 3
-- da doutrina, evento sem consumidor. Em vez de criar uma coluna nova com o
-- mesmo significado, esta migration dá dono à que já existe.
--
-- Aditiva e idempotente: afrouxar `not null` não pode ser violado por linha que
-- já passava pela regra antiga, então não há backfill nem deduplicação antes.

alter table public.webhook_events_log
  alter column raw_body drop not null;

comment on column public.webhook_events_log.raw_body is
  'Corpo cru como o provedor mandou. NULL = existiu e foi descartado pela retenção; `archived_at` diz quando.';

comment on column public.webhook_events_log.archived_at is
  'Quando as colunas pesadas (raw_body, payload_parsed, headers) foram descartadas pela retenção. NULL = a linha ainda tem o corpo.';

-- A varredura da retenção procura "linhas velhas que ainda têm corpo". Sem este
-- índice ela percorre a tabela inteira toda hora — e é justamente a tabela que
-- este arquivo existe para impedir que cresça. PARCIAL porque a esmagadora
-- maioria das linhas antigas já vai estar esvaziada: o índice encolhe sozinho
-- conforme a poda avança, que é o oposto de um índice sobre a tabela toda.
create index if not exists webhook_events_log_a_esvaziar_idx
  on public.webhook_events_log (received_at)
  where archived_at is null;
