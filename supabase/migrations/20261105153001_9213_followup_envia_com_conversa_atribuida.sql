-- manifest: `followup_flow_pointers.send_when_assigned` (default false) — a opção por fluxo "enviar mesmo com a conversa atribuída a uma pessoa" (#3974). Desligada, o follow-up de etapa continua cancelado/adiado por `pessoa_no_comando`; ligada, o passo de texto sai e a IA continua calada.
--
-- 9213 — o follow-up de etapa que quase nunca chega (#3974).
--
-- ─── O que foi medido ───────────────────────────────────────────────────────
--
-- Numa instalação real: 28 inscrições de etapa, 2 clientes atendidos e 7
-- canceladas com `cancel_reason = 'pessoa_no_comando'` já na primeira mensagem.
-- O vendedor com a conversa atribuída é o caso NORMAL: assumir, atribuir e
-- transferir gravam `bot_silenced_until = 'infinity'` (RPC
-- `fn_conversation_assign`), e `aplicarPessoaNoComandoAoTurno` aplica a
-- `handoff_policy` do fluxo ao encontrar `isLeadInHandoff` verdadeiro.
--
-- ─── A opção, e o que ela NÃO vence ─────────────────────────────────────────
--
-- `send_when_assigned = true` vale SÓ para a posse da conversa (uma pessoa é a
-- dona do thread). Continuam barrando o envio, como hoje: `force_human`
-- (handoff pedido pela IA ou pelo cliente), `ai_opt_out`, etiqueta de contato
-- interno, contato bloqueado, opt-out e as duas janelas de horário.
--
-- O veto do TURNO DA IA (`bot_silenced_until` em `inbound-turn.ts`) não muda:
-- a IA continua calada na conversa com dono. O que muda é o follow-up
-- PROGRAMADO poder sair — o pedido da issue.
--
-- ─── Por que coluna, e não chave em `trigger_config` ────────────────────────
--
-- O leitor é o motor de follow-up (`lib/followup/envio-com-o-dono.ts`), no
-- caminho quente do worker, e a tela já lê a linha do pointer (`DETAIL_COLUMNS`).
-- Uma chave nova dentro do jsonb de gatilho seria lida por outro objeto —
-- `trigger_config` é o QUANDO dispara, e esta opção é o QUE fazer quando uma
-- pessoa já está no comando.
--
-- Idempotente: `add column if not exists` + `comment` reaplicado.

alter table public.followup_flow_pointers
  add column if not exists send_when_assigned boolean not null default false;

comment on column public.followup_flow_pointers.send_when_assigned is
  'Envia o passo do follow-up mesmo com a conversa atribuída a uma pessoa (dono). Não vence force_human, ai_opt_out, contato interno, contato bloqueado nem as janelas de horário — e não acorda a IA.';
