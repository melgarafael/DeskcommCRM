-- manifest: **Catálogo Meta no WhatsApp Cloud API e tipo de mensagem product (issue #2801).** Suporte nativo a envio de produtos interativos do catálogo da Meta (Commerce Manager / WhatsApp Cloud API) no DeskcommCRM. Permite o envio de cards de produto pelo Inbox, por automações de follow-up e por ferramentas autônomas dos agentes de IA. A coluna `channel_sessions.meta_catalog_id` armazena o identificador do catálogo vinculado à sessão oficial do WhatsApp da organização, garantindo isolamento multi-tenant (RLS). A constraint `messages_type_check` passa a aceitar o tipo 'product' de primeira classe para auditoria, histórico e relatórios de conversão de catálogo.

-- 0653: catálogo Meta no canal oficial e mensagens do tipo product.
--
-- Detalhe completo no cabeçalho do bloco abaixo; o bloco é o MESMO, letra a
-- letra, no apêndice de `supabase/baseline.sql` — é ele que o `update.sh`
-- reaplica a cada atualização, inclusive em quem nunca vai rodar migrations.

-- ---- catálogo Meta e mensagem de produto (migration 0653, issue #2801) ----

alter table public.channel_sessions
  add column if not exists meta_catalog_id text;

comment on column public.channel_sessions.meta_catalog_id is
  'ID do Catálogo no Meta Commerce Manager vinculado a este número/WABA para envio de mensagens interativas de produto.';

do $$ begin
  alter table public.messages drop constraint if exists messages_type_check;
  alter table public.messages add constraint messages_type_check
    check (type = any (array[
      'text', 'image', 'video', 'audio', 'document', 'sticker',
      'location', 'contact', 'reaction', 'system',
      'template',
      -- novo: envio de produto do catálogo interativo do WhatsApp (Cloud API)
      'product'
    ]));
end $$;
