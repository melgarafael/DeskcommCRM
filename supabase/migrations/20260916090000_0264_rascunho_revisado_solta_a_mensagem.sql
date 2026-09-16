-- ============================================================================
-- 0264 — RASCUNHO REVISADO SOLTA A MENSAGEM
--
-- `ai_reply_drafts.message_id` nasceu na 0227 com REFERENCES sem ON DELETE.
-- A Zona de perigo apaga `messages` primeiro. Com uma resposta revisada
-- enviada, o Postgres recusa o DELETE (23503) e a action devolve db_error
-- em `falhou_em: messages`. As outras FKs para `messages` já são SET NULL.
--
-- SET NULL, não CASCADE: apagar UMA mensagem no inbox não pode levar o
-- rascunho embora. No reset da org, `conversations` CASCADE cobre o resto.
-- ============================================================================

do $$
declare
  v_nome text;
begin
  select c.conname into v_nome
    from pg_constraint c
   where c.conrelid = 'public.ai_reply_drafts'::regclass
     and c.contype = 'f'
     and c.conkey = array[(
       select attnum from pg_attribute
        where attrelid = 'public.ai_reply_drafts'::regclass
          and attname = 'message_id'
     )];
  if v_nome is not null then
    execute format('alter table public.ai_reply_drafts drop constraint %I', v_nome);
  end if;
end $$;

alter table public.ai_reply_drafts
  drop constraint if exists ai_reply_drafts_message_id_fkey;

alter table public.ai_reply_drafts
  add constraint ai_reply_drafts_message_id_fkey
  foreign key (message_id) references public.messages(id) on delete set null;
