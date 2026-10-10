-- 0033_conversation_tags
-- G3-05 (gov-loop): tags de conversa (eixo 7, spec 13 §3.3).
--
-- DIRC — Reuse do padrão: mesmíssimo shape de contacts.tags / crm_leads.tags
-- (text[] not null default '{}' + índice GIN). Coluna nova (Create), NÃO reuso
-- de contacts.tags: tag de contato qualifica a PESSOA (duradouro); tag de
-- conversa qualifica o ATENDIMENTO (episódico) — 1 contato tem N conversas de
-- categorias distintas.
--
-- Vocabulário canônico vive em organizations.settings.canonical_conversation_tags
-- (array jsonb) — org-scoped, não pipeline-scoped (spec 13 §3.3). Semeado com um
-- default pt-br de e-commerce APENAS onde a chave falta, pra sugestão não nascer
-- vazia; idempotente e reversível (admin edita settings).
--
-- Idempotente, portável em psql puro (sem BEGIN/COMMIT, sem temp tables).

alter table public.conversations
  add column if not exists tags text[] not null default '{}';

create index if not exists idx_conversations_tags_gin
  on public.conversations using gin (tags);

-- Vocabulário default (só onde ausente — auto-curativo, não sobrescreve edições)
update public.organizations
   set settings = coalesce(settings, '{}'::jsonb)
       || jsonb_build_object(
            'canonical_conversation_tags',
            jsonb_build_array(
              'dúvida', 'reclamação', 'troca', 'devolução',
              'elogio', 'orçamento', 'pós-venda', 'urgente'
            )
          )
 where not (coalesce(settings, '{}'::jsonb) ? 'canonical_conversation_tags');
