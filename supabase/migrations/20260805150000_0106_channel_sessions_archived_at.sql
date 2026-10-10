-- 0106 — channel_sessions.archived_at
--
-- Permite "excluir" um canal WhatsApp da Central de Conexões sem destruir o
-- histórico. Excluir de verdade (DELETE na linha) só é possível para um canal
-- virgem: conversations, messages e ai_agent_versions referenciam
-- channel_sessions com ON DELETE RESTRICT, então o banco recusa apagar um canal
-- que já atendeu alguém — e isso é o comportamento correto, não um obstáculo.
--
-- Para os canais com histórico, arquivar é a saída: o acesso ao número é
-- revogado no provider — sessão deslogada e removida no canal pareado por QR;
-- credencial apagada e caminho de webhook rotacionado no canal oficial, que não
-- tem sessão a deslogar —, a linha permanece como âncora das FKs, e a UI deixa
-- de listá-la. A resolução de sessão dos webhooks filtra `archived_at`, para que
-- evento em voo não ressuscite o canal.
--
-- Coluna nullable sem default: aditiva, não reescreve a tabela, e toda linha
-- existente continua ativa (archived_at IS NULL).

alter table public.channel_sessions
  add column if not exists archived_at timestamptz;

comment on column public.channel_sessions.archived_at is
  'Quando não-nulo, o canal foi arquivado pelo usuário: some da UI e não é mais '
  'elegível para envio. A linha sobrevive porque conversations/messages a '
  'referenciam com ON DELETE RESTRICT.';

-- A Central de Conexões e o seletor do inbox filtram por archived_at IS NULL
-- em toda listagem; o índice parcial mantém esse caminho barato.
create index if not exists channel_sessions_org_active_idx
  on public.channel_sessions (organization_id, created_at)
  where archived_at is null;
