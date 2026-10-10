-- 0120 — avisos de CANAL na Central: definição revisada, número em risco.
--
-- ─── O que estava invisível ────────────────────────────────────────────────
--
-- A plataforma avisa quando uma definição aprovada muda de estado (APPROVED,
-- REJECTED, PAUSED, DISABLED) e quando o número entra em risco (suspenso,
-- recusado, exigindo ação, liberado). Nada disso chegava ao operador: o
-- template era recusado e a descoberta acontecia no disparo que não saiu; o
-- número era suspenso e a descoberta acontecia com o cliente esperando.
--
-- Dois kinds, e não um por evento:
--
--   `channel_template_review` — a definição mudou de estado. O que muda é o
--     estado, e ele já vive em `meta_templates.status`; o aviso é o empurrão
--     para olhar, não uma segunda fonte da verdade.
--
--   `channel_number_alert` — o número precisa de atenção. Suspenso, recusado,
--     KYC pendente e liberado são desfechos diferentes da MESMA pergunta ("dá
--     para enviar por este número?"), e um kind por evento encheria a Central
--     de categorias que ninguém filtra separado. O evento exato vai no payload.
--
-- ─── Um bloco, vocabulário final ───────────────────────────────────────────
--
-- A constraint é RECRIADA aqui, no lugar onde ela já vive (regra de
-- `tests/unit/baseline-constraint-reconstruida.test.ts`): dois blocos fariam o
-- `update.sh` de um clone com dados falhar no primeiro e deixar a tabela sem
-- constraint entre o drop e o add que funciona.
--
-- Idempotente e aditiva: a lista de kinds só CRESCE, então nenhuma linha
-- existente passa a violar. Nada a corrigir antes.

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'qr_rescan',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    -- (migration 0109, issue #129) Mensagem outbound nasce `sending` e, quando o
    -- envio nunca acontece, fica `sending` para sempre — o self-hoster vê uma
    -- mensagem eternamente "enviando", sinal de progresso para algo que não vai
    -- acontecer. O cron `recover-stuck-messages` marca `failed` e usa este kind
    -- para o defeito APARECER na Central de avisos.
    --
    -- Entra NESTA lista, e não num bloco novo no fim do arquivo: o #159 do @jmpo
    -- mostrou que reconstruir a mesma constraint em N blocos quebra o
    -- `update.sh` de todo clone que já tenha uma linha de vocabulário posterior
    -- — os blocos antigos rodam antes e falham em cadeia. Um bloco por
    -- constraint, vigiado por tests/unit/baseline-constraint-reconstruida.test.ts.
    'message_send_stuck',
    'channel_template_review',
    'channel_number_alert',
    -- (migrations 0129 e 0124, vindas da main na convergência) Esta migration
    -- roda DEPOIS da 0139 pelo timestamp, e reconstrói a MESMA constraint. Sem
    -- estes dois nomes aqui, aplicar a 0120 num clone atualizado APAGARIA dois
    -- kinds em uso — a lista de quem reconstrói por último é a que vale, e uma
    -- lista incompleta não é "aditiva", é uma remoção silenciosa.
    'midia_nao_lida',
    'contact_proposal_expired',
    -- (migration 0111, spec 16 §3.2) O papel Operador declara promessa em aberto:
    -- o assistente prometeu algo ao cliente e o cumprimento não foi registrado.
    -- A invariante sagrada da spec é "nenhuma promessa deixa de ser cumprida", e
    -- uma promessa sem dono precisa aparecer onde o humano olha — não no log do
    -- worker. Entra NESTA lista pela mesma razão que a de cima.
    'promise_unfulfilled',
    'other'
  ));
