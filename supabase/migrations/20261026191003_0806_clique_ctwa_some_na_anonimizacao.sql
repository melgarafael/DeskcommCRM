-- manifest: **O registro de clique em anúncio (`meta_ctwa_click_dispatches`) some quando o contato é anonimizado (#3128, doc 199 pergunta 2 = A).** A tabela guarda o `ctwa_clid`, que liga a pessoa ao anúncio em que ela clicou na Meta — dado pessoal. A anonimização não exclui o contato, então o `on delete cascade` da tabela nunca dispara num pedido do titular. O gatilho `trg_contacts_anonimizado_apaga_cliques_ctwa` APAGA as linhas do contato na virada de `is_anonymized` (o mesmo desenho de `fn_apaga_propostas_de_contato_anonimizado`): a porta por onde os dois caminhos de anonimização passam. Custo aceito no doc 199: se a Meta reenviar um clique antigo dessa pessoa, ele é contado de novo. Idempotente; espelhado no apêndice do `baseline.sql` logo depois do bloco da 0805. Gates: `tests/invariants/meta-lead-por-clique.test.ts` e a decisão em `tests/invariants/lgpd-redact-unificado-alcanca-pelo-catalogo.test.ts`.
create or replace function public.fn_apaga_cliques_ctwa_de_contato_anonimizado()
  returns trigger
  language plpgsql
  security definer
  set search_path to ''
as $$
begin
  delete from public.meta_ctwa_click_dispatches
   where organization_id = new.organization_id and contact_id = new.id;
  return new;
end$$;

revoke execute on function public.fn_apaga_cliques_ctwa_de_contato_anonimizado() from public, anon, authenticated;

drop trigger if exists trg_contacts_anonimizado_apaga_cliques_ctwa on public.contacts;
create trigger trg_contacts_anonimizado_apaga_cliques_ctwa
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized = true and coalesce(old.is_anonymized, false) = false)
  execute function public.fn_apaga_cliques_ctwa_de_contato_anonimizado();
