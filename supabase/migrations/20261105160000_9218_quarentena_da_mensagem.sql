-- manifest: **A mensagem recebida pode ficar em quarentena sem ser descartada (#4026, fatia 1).** `messages` ganha `quarantined_at timestamptz`, `quarantine_reason text` e `quarantined_by_user_id uuid`: a linha da mensagem continua sendo a única fonte (id, corpo e mídia intactos), e o trio é a marca auditável — quando, por quê e por quem. Enquanto `quarantined_at` não é nula, os consumidores do `event_log` (automação, push, campanha, follow-up) e o dreno do turno do agente não agem sobre ela, e a ingestão pula os efeitos automáticos; a liberação zera o trio e o fluxo normal volta. Índice parcial `idx_messages_em_quarentena` para a revisão e para a leitura dos consumidores. CHECK `messages_quarentena_com_motivo`: marca sem motivo é recusada — auditoria não nasce anônima. Idempotente (`add column if not exists`), sem backfill: nulo é exatamente o comportamento de hoje. Não cria função, então o espelho no apêndice do `baseline.sql` fica depois da VARREDURA anon.
--
-- 9218 — quarentena que NÃO perde mensagem.
--
-- ─── O estado que faltava ───────────────────────────────────────────────────
--
-- Hoje só existem dois jeitos de uma mensagem recebida não acordar o agente:
-- o canal que o operador desativou (`lib/channels/desativado.ts`) e o contato
-- que o próprio cliente bloqueou com STOP (`lib/opt-out/deteccao.ts`). Nenhum
-- dos dois serve para "esta mensagem parece spam/golpe": o primeiro é do canal
-- inteiro, o segundo do contato inteiro, e os dois ESCONDEM a mensagem.
--
-- A quarentena é o oposto dos dois em ambos os eixos: é POR MENSAGEM e NÃO
-- esconde nada. A linha nasce normal — é a mesma `insert` da ingestão, com
-- `body`, `media_url` e `external_id` intactos —, e o que muda é só o trio
-- abaixo. Quem lê blacklist, quem apaga mensagem ou quem filtra a lista da
-- inbox por este campo está fazendo outra coisa; aqui a mensagem está na
-- conversa, para o humano revisar.
--
-- ─── Por que colunas, e não uma tabela paralela ─────────────────────────────
--
-- Porque a pergunta que os consumidores fazem é "esta mensagem?" — e eles já
-- têm o id. Uma tabela `message_quarantine` custaria um join em três caminhos
-- quentes (dreno do evento, dreno do turno, ingestão) para responder o que a
-- própria linha responde por chave primária, e criaria o estado que este
-- produto não quer: mensagem em quarentena sem linha de mensagem (ou o
-- contrário, na hora de apagar uma das duas).
--
-- ─── O que cada coluna responde ─────────────────────────────────────────────
--
-- · `quarantined_at` — QUANDO. Nulo é "não está em quarentena"; não existe
--   booleano separado, então não há como as duas colunas discordarem.
-- · `quarantine_reason` — POR QUÊ, em texto de quem decidiu. É o rastro que o
--   operador lê na revisão e o que a auditoria guarda; o CHECK abaixo recusa
--   marca vazia, porque marca sem motivo é indistinguível de defeito.
-- · `quarantined_by_user_id` — POR QUEM. Sem FK de propósito, como
--   `messages.sent_by_user_id`: a linha de auditoria (`message.quarantined`)
--   guarda o ator, e uma FK aqui faria apagar usuário apagar o rastro da
--   mensagem (ou exigir `set null` em massa numa tabela de histórico).
alter table public.messages add column if not exists quarantined_at timestamp with time zone;
alter table public.messages add column if not exists quarantine_reason text;
alter table public.messages add column if not exists quarantined_by_user_id uuid;

-- A marca sem motivo é recusada no BANCO, não só na rota: o caminho de escrita
-- não é um só (rota hoje, detecção na fatia seguinte) e auditoria anônima não
-- serve para nada. `drop` colado no `add` é o que mantém a reaplicação do
-- baseline idempotente.
alter table public.messages drop constraint if exists messages_quarentena_com_motivo;
alter table public.messages add constraint messages_quarentena_com_motivo
  check (quarantined_at is null or (quarantine_reason is not null and btrim(quarantine_reason) <> ''));

-- Parcial: só as linhas marcadas entram no índice. Serve à tela de revisão (a
-- fatia seguinte) e às leituras de consumidor que um dia quiserem varrer o que
-- está segurado; a leitura por id que existe hoje é chave primária e não usa
-- este índice.
create index if not exists idx_messages_em_quarentena
  on public.messages (organization_id, quarantined_at)
  where quarantined_at is not null;

comment on column public.messages.quarantined_at is
  'Quando a mensagem entrou em quarentena (#4026). Nula = fluxo normal. A linha e o corpo NÃO mudam: quarentena segura o efeito (IA, automação, push), não a mensagem.';
comment on column public.messages.quarantine_reason is
  'Por que a mensagem foi segurada, em texto de quem decidiu. Obrigatório quando quarantined_at não é nula (CHECK messages_quarentena_com_motivo).';
comment on column public.messages.quarantined_by_user_id is
  'Quem pôs a mensagem em quarentena. Sem FK de propósito: o rastro é a auditoria message.quarantined, e usuário apagado não pode apagar o histórico da mensagem.';

notify pgrst, 'reload schema';
