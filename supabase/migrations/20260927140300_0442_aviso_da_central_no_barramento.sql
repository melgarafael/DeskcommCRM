-- 0442 — o aviso da Central anuncia no barramento que nasceu.
--
-- Os avisos que pedem gente (a IA passou a conversa para uma pessoa; a IA
-- ficou sem saldo no provedor; um negócio entrou numa etapa que avisa, 0440)
-- só existiam na tela: com o CRM fechado, ninguém sabia. O push para o celular
-- já existia para mensagem nova, e faltava o gancho destes. TRIGGER e não
-- emissor em código pelo mesmo motivo da 0148: os avisos nascem em vários
-- lugares (motor, rotas, handlers, crons), e o próximo caminho nasceria mudo.
-- SQL puro, sem I/O — quem manda o push é o consumidor
-- (`lib/notifications/push.handler.ts`), e é ele quem decide QUAIS avisos vão
-- para o celular (`somDoAviso`, a mesma regra do som da Central).
--
-- O aviso NUNCA deixa de nascer por causa do anúncio: o `emit_event` fica num
-- bloco que engole a falha. Um aviso de passagem para pessoa que não grava porque
-- o barramento recusou seria o pior desfecho possível.
create or replace function public.fn_emit_aviso_da_central()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Aviso de PLATAFORMA (organização nula) não vai para o celular de ninguém.
  if new.organization_id is null then
    return null;
  end if;
  begin
    perform public.emit_event(
      'central.aviso_criado',
      'agent_inbox_item',
      new.id,
      jsonb_build_object(
        'item_id',  new.id,
        'kind',     new.kind,
        'ref_kind', new.ref_kind,
        'ref_id',   new.ref_id
      ),
      '{}'::jsonb,
      new.organization_id   -- SEMPRE de `new`: é o filtro de tenant
    );
  exception when others then
    raise warning 'fn_emit_aviso_da_central: anúncio do aviso % falhou: %', new.id, sqlerrm;
  end;
  return null;              -- AFTER trigger: o retorno é ignorado
end;
$$;

alter function public.fn_emit_aviso_da_central() owner to postgres;

-- As DUAS origens de EXECUTE (doutrina de migrations, item 9). Função de
-- trigger: ninguém a chama pela REST, então não há `grant` a ninguém.
revoke all     on function public.fn_emit_aviso_da_central() from public;
revoke execute on function public.fn_emit_aviso_da_central() from anon, authenticated;

drop trigger if exists trg_aviso_da_central_criado on public.agent_inbox_items;
create trigger trg_aviso_da_central_criado
  after insert on public.agent_inbox_items
  for each row execute function public.fn_emit_aviso_da_central();
