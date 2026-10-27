-- manifest: Permissão opcional `turn.context` para o host resolver somente uma opção declarada a partir de OUTBOUND já selecionado no turno e com proveniência da mesma organização/conversa. Aceite próprio, sem backfill nem concessão automática; não libera consultas ao CRM, histórico novo ou código do pacote. A ativação continua exigindo envio/passagem, a leitura é opcional e a recusa 6-bis de alterar permissões entre versões permanece. Forward da proposta 0798, preparada para replay com o vocabulário completo sem conceder aceite.
create or replace function public.fn_extensions_permissoes_validas(p_permissions jsonb)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select p_permissions is not null
    and jsonb_typeof(p_permissions) = 'array'
    and jsonb_array_length(p_permissions) between 1 and 11
    and not exists (
      select 1 from jsonb_array_elements(p_permissions) e
      where jsonb_typeof(e.value) <> 'string'
         or e.value #>> '{}' not in (
              'navigation.tasks', 'navigation.inbox', 'navigation.kanban',
              'navigation.contacts', 'navigation.agenda', 'navigation.radar',
              'theme.apply', 'dados.proprios',
              'turn.send', 'turn.handoff', 'turn.context')
    )
    and (select count(distinct e.value) from jsonb_array_elements(p_permissions) e)
        = jsonb_array_length(p_permissions);
$$;

revoke execute on function public.fn_extensions_permissoes_validas(jsonb) from public, anon;
revoke execute on function public.fn_extensions_permissoes_validas(jsonb) from authenticated;
grant execute on function public.fn_extensions_permissoes_validas(jsonb) to service_role;


-- A proposta 0798 já admite o nome futuro antes de recriar o CHECK, para que
-- o replay integral passe com ON_ERROR_STOP=1 e aceite de leitura existente.
-- Reafirma aqui o CHECK final, sem apagar nem conceder consentimento.
alter table public.organization_extensions
  drop constraint if exists organization_extensions_accepted_permissions_check;
alter table public.organization_extensions
  add constraint organization_extensions_accepted_permissions_check
  check (cardinality(accepted_permissions) = 0 or public.fn_extensions_permissoes_validas(to_jsonb(accepted_permissions)));
