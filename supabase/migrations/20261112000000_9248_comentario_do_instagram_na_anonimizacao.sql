-- manifest: #4075 — o comentário do Instagram sai na anonimização da ficha (channel_comments no redator da virada)
--
-- ─── O QUE FALTAVA ──────────────────────────────────────────────────────────
--
-- A 9220 criou `channel_comments` guardando o TEXTO do comentário e quem o
-- escreveu (`author_id`, `author_username`, `author_name`), com FK para
-- `contacts`. Ninguém a acrescentou ao redator da virada de `is_anonymized`, e
-- o modo de falha é o mudo de sempre: anonimizar devolve SUCESSO, a contagem
-- fecha, o SLA D+15 é marcado como cumprido, e o comentário — com o handle de
-- quem exerceu o direito — continua legível.
--
-- ─── POR QUE NO REDATOR DA VIRADA, e não na cascata ─────────────────────────
--
-- `fn_reply_redact` é a porta que os DOIS caminhos de anonimização atravessam
-- (o pedido formal, que passa por `fn_lgpd_cascade_redact_contact`, e o botão da
-- ficha, que vira `is_anonymized` direto): o gatilho `trg_reply_redact` é AFTER
-- UPDATE OF is_anonymized em `contacts` com a condição `new.is_anonymized and
-- not old.is_anonymized`. É o mesmo desenho da 0391/0494, que já alcança
-- `ai_reply_drafts`, `lead_notes` e `lead_state` por aqui.
--
-- A LINHA FICA, o conteúdo sai: a chave única `(organization_id, provider,
-- external_id)` é a trava de reentrega do provedor e o vínculo com o post é o
-- que sustenta o histórico do gatilho. O que identifica a pessoa e o que ela
-- escreveu vira resíduo — `author_id` recebe o tombstone `'removido'` (a coluna
-- é NOT NULL) e o texto vira `'[comentário anonimizado]'`.
--
-- Idempotente (`create or replace`), mesma assinatura e mesmo grant do 0227
-- (revoke repetido para o arquivo ficar autocontido).

create or replace function public.fn_reply_redact() returns trigger language plpgsql security definer set search_path=public as $$
begin
 update public.ai_reply_drafts set original_body=null,edited_body=null,approved_body=null,proposals='[]',trace='[]',feedback=null,status=case when status='sent' then status else 'stale' end,error_code='redacted',updated_at=now() where organization_id=new.organization_id and contact_id=new.id;
 update public.job_queue set payload='{}',status=case when status in('pending','running') then 'failed' else status end,locked_by=null,locked_at=null,last_error='reply_redacted' where organization_id=new.organization_id and contact_id=new.id and kind='approved_reply';
 update public.channel_comments set author_id='removido',author_username=null,author_name=null,text=case when text is null then null else '[comentário anonimizado]' end where organization_id=new.organization_id and contact_id=new.id;
 return new;
end;$$;
revoke all on function public.fn_reply_redact() from public,anon,authenticated;
