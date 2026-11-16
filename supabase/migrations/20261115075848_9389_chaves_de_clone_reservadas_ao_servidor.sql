-- manifest: **O vínculo de clone do card só é gravado pelo servidor.** As chaves `clonado_de` e `movido_para` de `crm_leads.source_metadata` ligam o card de origem à sua continuação em outro funil, e a automação `create_or_move_lead` reconhece a continuação por `source_metadata->clonado_de->>lead_id`. Elas passam a ser reservadas como já é a `meta_capi_lead_birth_v1`: o gatilho `trg_guard_vinculo_de_clone_do_lead` (BEFORE INSERT/UPDATE OF source_metadata) recusa com 42501 `crm_lead_clone_link_reserved` quando a sessão (`authenticated`/`anon`) cria um card com essas chaves ou muda o valor delas; o resto de `source_metadata` segue editável, e `service_role` e funções `security definer` passam. Os três escritores do vínculo (rota `/clone`, ação `create_or_move_lead`, transferência por etiqueta) gravam pelo cliente de serviço com `organization_id` filtrado à mão. Daqui para a frente: dados antigos não são reescritos. Idempotente (`create or replace` + `drop trigger if exists`); espelho idêntico no apêndice do `baseline.sql`, antes da cascata da 9243. Prova em `tests/invariants/vinculo-de-clone-so-do-servidor.test.ts`.

-- O VÍNCULO DE CLONE DO CARD É DO SERVIDOR
--
-- `clonado_de` (no card novo) e `movido_para` (no card de origem) são o elo
-- entre os dois lados de uma troca de funil. A ação `create_or_move_lead`
-- decide por ele se a continuação de um negócio já existe — então ele tem o
-- mesmo estatuto da prova `meta_capi_lead_birth_v1`: só quem escreve é o
-- servidor. A sessão do navegador continua editando o resto de
-- `source_metadata`; reenviar o valor que já está lá (sem mudá-lo) também passa.
--
-- O critério é o PAPEL que executa a escrita, não o dono da função: dentro de
-- uma função `security definer` o `current_user` é o dono dela, e por isso a
-- cascata de LGPD (que zera `source_metadata`) e as RPCs do sistema seguem
-- passando. `fn_nascer_lead_da_conversa` é `security invoker` e chamável por
-- `authenticated`: pela sessão, ela também não grava as chaves.
--
-- Vale daqui para a frente: nenhum dado existente é reescrito.

create or replace function public.fn_guard_vinculo_de_clone_do_lead()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon')
     and (case when tg_op = 'INSERT'
               then coalesce(new.source_metadata ?| array['clonado_de', 'movido_para'], false)
               else (new.source_metadata->'clonado_de') is distinct from (old.source_metadata->'clonado_de')
                 or (new.source_metadata->'movido_para') is distinct from (old.source_metadata->'movido_para')
          end) then
    raise exception 'crm_lead_clone_link_reserved'
      using errcode = '42501',
            detail = 'source_metadata.clonado_de e source_metadata.movido_para são gravados só pelo servidor.';
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_guard_vinculo_de_clone_do_lead() from public, anon, authenticated;
grant execute on function public.fn_guard_vinculo_de_clone_do_lead() to service_role;
drop trigger if exists trg_guard_vinculo_de_clone_do_lead on public.crm_leads;
create trigger trg_guard_vinculo_de_clone_do_lead before insert or update of source_metadata
  on public.crm_leads for each row execute function public.fn_guard_vinculo_de_clone_do_lead();
