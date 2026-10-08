-- manifest: **Marcar um contato como pessoal remove os trechos JÁ ingeridos no RAG (issue #2394).** A rota do marcar zerava `conversations.usable_for_rag`, o que impede só as ingestões futuras; os `ai_chunks` já gravados seguiam alcançáveis por `retrieve_top_k_chunks`, que filtra só organização e versão. A função nova `fn_contato_pessoal_remove_trechos_do_rag` apaga os trechos cujo `metadata.conversation_id` pertence às conversas do contato (na mesma organização) e devolve a contagem, que a rota leva para os `effects` e para a auditoria `contact.marked_personal`. Desmarcar NÃO reingere (D8 da spec 21). Idempotente: `create or replace`; apêndice igual no fim do `baseline.sql`.

-- ============================================================================
-- 0564 — O CONTATO PESSOAL TIRA OS TRECHOS JÁ INGERIDOS DO RAG (#2394)
--
-- O defeito medido: `POST /contacts/[id]/personal` zerava `usable_for_rag` das
-- conversas do contato, o que impede só as ingestões FUTURAS (o lote novo
-- exclui pessoal na leitura). Os trechos já ingeridos ficavam em `ai_chunks`,
-- e `retrieve_top_k_chunks` os alcançava: a marcação tirava a conversa da
-- operação, mas o agente continuava podendo trazer um trecho dela como
-- conhecimento. Mesma lacuna da #1957 na LGPD.
--
-- ─── A remoção ───────────────────────────────────────────────────────────────
--
-- Um `delete` só, por `metadata.conversation_id` (o campo que a ingestão de
-- conversas grava em `lib/ai/rag/ingest/conversations.ts`) casado com as
-- conversas do contato NA MESMA organização. `row_count` volta como contagem —
-- a rota leva o número para os `effects` e para a auditoria
-- `contact.marked_personal` (o metadata dela já espalha os efeitos).
--
-- O recorte é pelas CONVERSAS do contato, não pela fonte nem pelo agente: uma
-- fonte de conversas pode conter trechos de vários contatos, e apagar a fonte
-- inteira levaria o que é dos outros.
--
-- ─── O que NÃO acontece ──────────────────────────────────────────────────────
--
-- Desmarcar não reingere (D8, espelha o desbloqueio): a conversa volta à vista
-- e volta ao acervo só se alguém a marcar de novo como útil para o RAG. A rota
-- DELETE não chama esta função.
-- ============================================================================

create or replace function public.fn_contato_pessoal_remove_trechos_do_rag(p_org uuid,p_contact uuid)
returns integer language plpgsql security definer set search_path=public as $$
declare removidos integer;
begin
 if auth.uid() is not null and not public.fn_role_at_least(p_org,'manager') then
  raise exception 'caller_not_authorized_for_org'
    using hint = 'fn_contato_pessoal_remove_trechos_do_rag: caller must be manager of the organization';
 end if;
 delete from public.ai_chunks c
   using public.conversations v
  where c.organization_id=p_org
    and v.organization_id=p_org
    and v.contact_id=p_contact
    and c.metadata->>'conversation_id'=v.id::text;
 get diagnostics removidos = row_count;
 return removidos;
end $$;
revoke all on function public.fn_contato_pessoal_remove_trechos_do_rag(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_contato_pessoal_remove_trechos_do_rag(uuid,uuid) to service_role;

notify pgrst,'reload schema';
