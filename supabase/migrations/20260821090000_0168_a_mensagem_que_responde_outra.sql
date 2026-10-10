-- ============================================================================
-- 0168 — A MENSAGEM QUE RESPONDE OUTRA.
--
-- O canal intermediado aceita citação (`replyTo` no envio, recebendo o `wamid`
-- da mensagem citada), e o WhatsApp mostra a resposta pendurada na original —
-- que é como as pessoas conversam ali. Sem guardar QUEM foi citado, o CRM
-- manda a citação para o cliente e não consegue mostrá-la de volta na própria
-- tela: o atendente vê frases soltas onde o cliente vê um fio.
--
-- ─── Por que uma FK, e não o wamid solto ───────────────────────────────────
--
-- Porque a pergunta da tela é "qual mensagem NOSSA foi citada?", e a resposta é
-- uma linha desta tabela. Guardar o `external_id` do provider faria toda
-- renderização buscar por uma coluna de texto — e, pior, deixaria de funcionar
-- para a citação de uma mensagem que ainda não tem `external_id` (a nossa,
-- enquanto está `queued`). É o `R` da DIRC: a linha já existe, aqui basta o
-- ponteiro.
--
-- O `external_id` que o provider precisa continua saindo da linha apontada, no
-- momento do envio — uma leitura a mais, e nenhuma cópia que possa divergir.
--
-- ─── `on delete set null`, nunca cascade ───────────────────────────────────
--
-- Apagar a mensagem citada não pode levar junto a resposta: a resposta é
-- conteúdo próprio, dita por alguém, e some sozinha só se quem a disse mandar.
-- Perder a citação é aceitável (a tela mostra a resposta sem o fio); perder a
-- resposta seria apagar histórico de atendimento por causa de um ponteiro.
--
-- Índice PARCIAL: a esmagadora maioria das mensagens não cita ninguém, e um
-- índice cheio de NULL só ocupa espaço. O predicado é o mesmo que a tela usa.
-- ============================================================================

alter table public.messages
  add column if not exists reply_to_message_id uuid
    references public.messages(id) on delete set null;

create index if not exists messages_reply_to_idx
  on public.messages (reply_to_message_id)
  where reply_to_message_id is not null;

comment on column public.messages.reply_to_message_id is
  'A mensagem que esta responde (citação). NULL = envio solto, o caso comum. '
  'O id que o provider recebe em `replyTo` sai do `external_id` da linha apontada.';
