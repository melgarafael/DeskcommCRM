-- 0165 — o identificador do canal passa a ser único entre os canais ATIVOS
--
-- `channel_sessions.waha_session_name` é UNIQUE desde o snapshot e
-- `webhook_path_token` também. Os dois identificadores que chegaram depois —
-- `meta_phone_number_id` (0087) e `zernio_account_id` (0131) — nasceram SEM
-- trava nenhuma, e é sobre eles que o código resolve credencial e dono de
-- mensagem. Esta migration fecha essa assimetria.
--
-- ─── O que a ausência da trava produzia (issue #236) ────────────────────────
-- Três consultas resolviam uma sessão só por esse identificador, num client de
-- service role (que bypassa RLS):
--
--   lib/channels/meta/credentials.ts    → credencial de envio
--   lib/channels/zernio/credentials.ts  → credencial de envio
--   lib/channels/meta/ingest.ts         → a ORGANIZAÇÃO dona de uma mensagem
--                                          que acabou de entrar
--
-- Com duas linhas casando, `maybeSingle()` NÃO devolve "a primeira": medido
-- contra @supabase/postgrest-js 2.112.1 ele devolve `data: null` com
-- `error PGRST116` e HTTP 406. Como os três descartavam o `error`, o desfecho
-- era silencioso — os dois resolvedores caíam no fallback do `.env` (a mensagem
-- saía pela conta de OUTRA instalação) e a ingestão devolvia `no_session` com a
-- rota respondendo 200 (a mensagem de entrada era descartada para as DUAS
-- organizações). O código foi corrigido nas três camadas; esta é a que torna a
-- ambiguidade IMPOSSÍVEL em vez de apenas improvável.
--
-- ─── Como se chegava lá: configuração legítima, não ataque ──────────────────
-- A rota de conexão não aceita um identificador qualquer: `validatePartnerCredentials`
-- (lib/channels/connect.ts) lista as contas que a chave informada alcança e
-- exige que o `accountId` esteja na lista. Um admin hostil de outra organização
-- não reivindica o identificador alheio sem já possuir credencial que o alcance.
-- A colisão nasce de configuração legítima — agência que atende dois clientes,
-- migração de uma WABA entre organizações — e por isso o desfecho é o mesmo:
-- as duas organizações param de funcionar.
--
-- ─── Por que índice PARCIAL `where archived_at is null` (precedente: 0107) ──
-- O invariante real é "um identificador vive em UM canal ATIVO". Canal arquivado
-- é canal excluído pelo usuário (0106): a linha só sobrevive como âncora das FKs
-- `ON DELETE RESTRICT` de conversations/messages. Uma trava total impediria
-- reconectar o MESMO número depois de excluí-lo — exatamente o defeito que a
-- 0107 consertou para `(organization_id, phone_number)`. E o recorte do índice
-- é o MESMO que as três consultas passam a usar (`.is('archived_at', null)`),
-- senão a trava garantiria um conjunto e o código leria outro.
--
-- ─── A deduplicação: quem perde e o que acontece com a linha perdedora ──────
-- Constraint nova falha se os dados atuais a violam, e o `update.sh` do clone
-- roda SEM `ON_ERROR_STOP` — falharia em verde, deixando o clone sem a trava e
-- sem ninguém saber. Então os dados são corrigidos ANTES.
--
-- APAGAR está fora de questão: é sessão de canal de um cliente, com histórico
-- pendurado por FK RESTRICT. ARQUIVAR também foi recusado — o canal sumiria da
-- tela sem o usuário ter pedido e sem nada avisar, que é a definição de perda
-- silenciosa. A escolha é RENOMEAR o identificador da linha perdedora,
-- acrescentando `-conflito-<id da sessão>`:
--
--   * a linha continua visível na Central de Conexões (nada foi excluído);
--   * o identificador novo não existe no provider, então a varredura de saúde
--     (`app/api/v1/cron/channel-health`) recebe recusa na próxima passada,
--     grava `FAILED`/`STOPPED` e ABRE aviso na Central — os três estados estão
--     em `STATUS_QUE_AVISAM` (lib/channels/health.ts). O operador é avisado de
--     que precisa reconectar, em vez de descobrir pelo cliente que não recebeu;
--   * o sufixo carrega o `id` da sessão, que é o que se digita para investigar.
--
-- Quem FICA com o identificador é a sessão ativa mais RECENTE. Razão: para
-- criar a mais nova foi preciso provar posse da conta na tela de conexão (ver
-- acima), então a configuração mais recente é a intenção mais recente — é a
-- direção certa numa migração de conta entre organizações, que é o caso comum.
-- Custo de errar o palpite: a linha perdedora não é destruída e ela mesma avisa.
--
-- Idempotente por construção: depois da primeira passada não sobra duplicata
-- (o sufixo carrega o `id`, que é único), então a segunda casa zero linhas e
-- não há como sufixar duas vezes.
--
-- Os nomes dos índices são NOVOS — conferido contra `baseline.sql` e contra
-- `supabase/migrations/` —, então o `if not exists` (que casa por NOME) não tem
-- como virar no-op silencioso em cima de um índice homônimo com outra definição.

-- ---- canal oficial ----
with ativos as (
  select id,
         row_number() over (
           partition by meta_phone_number_id
           order by created_at desc nulls last, id desc
         ) as posicao
    from public.channel_sessions
   where archived_at is null
     and meta_phone_number_id is not null
)
update public.channel_sessions s
   set meta_phone_number_id = s.meta_phone_number_id || '-conflito-' || s.id::text
  from ativos a
 where a.id = s.id
   and a.posicao > 1;

create unique index if not exists channel_sessions_meta_phone_number_id_ativo_unique
  on public.channel_sessions (meta_phone_number_id)
  where archived_at is null and meta_phone_number_id is not null;

-- ---- canal intermediado ----
with ativos as (
  select id,
         row_number() over (
           partition by zernio_account_id
           order by created_at desc nulls last, id desc
         ) as posicao
    from public.channel_sessions
   where archived_at is null
     and zernio_account_id is not null
)
update public.channel_sessions s
   set zernio_account_id = s.zernio_account_id || '-conflito-' || s.id::text
  from ativos a
 where a.id = s.id
   and a.posicao > 1;

create unique index if not exists channel_sessions_zernio_account_id_ativo_unique
  on public.channel_sessions (zernio_account_id)
  where archived_at is null and zernio_account_id is not null;
