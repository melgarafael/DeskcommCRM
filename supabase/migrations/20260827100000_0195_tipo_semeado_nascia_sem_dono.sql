-- 0195 — os três tipos que o produto semeia nasciam SEM DONO, e sem dono não há agenda.
--
-- `fn_semear_tipos_de_agendamento` insere `(organization_id, name, slug, category,
-- duration_minutes, position)` e nunca define `default_owner_user_id`. E a consulta de
-- horários livres EXIGE dono: sem ele devolve `sem_responsavel`. Medido no caminho real
-- pela cerca `agenda-marcar-pela-tela`: a rota respondeu 422 três vezes com "Atendimento não
-- tem responsável definido".
--
-- Consequência: TODA organização nova nasce com três tipos de agendamento que não produzem
-- horário nenhum, para sempre, até alguém definir dono por fora. Os três tipos que o produto
-- semeia são decorativos — o usuário abre a Agenda numa instalação fresca, clica em Novo
-- agendamento, e não há horário. Nunca.
--
-- ⚠️ POR QUE O SEED NÃO PODE RESOLVER SOZINHO: o trigger é `after insert on organizations`,
-- e naquele instante NÃO EXISTE usuário vinculado — `user_organizations` ainda está vazia
-- para essa org. Não há dono a escolher; a função não estava errada, estava cedo.
--
-- A saída é o outro lado do tempo: preencher quando o PRIMEIRO membro chega. E só o
-- primeiro — se preenchesse a cada membro novo, um tipo que o operador deliberadamente
-- deixou sem dono voltaria a ganhar um, e o produto passaria a desfazer escolha de gente.

create or replace function public.fn_adotar_tipos_de_agendamento_sem_dono()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- Só o primeiro membro ATIVO da organização.
  --
  -- ⚠️ As duas condições nasceram de um caso que a predição pegou antes do commit: sem
  -- `new.revoked_at is null`, uma linha que JÁ nasce revogada adota os tipos e o dono padrão
  -- da agenda vira alguém que nunca esteve lá. E contar TODOS em vez de só os ativos criaria
  -- o furo simétrico: numa org com um ex-membro, o primeiro membro de verdade veria contagem
  -- 2 e não adotaria nada — a org ficaria órfã para sempre.
  --
  -- `= 1` e não `> 0`: neste ponto a linha nova já está na tabela, então o primeiro ativo
  -- vê contagem 1.
  if new.revoked_at is null
     and (select count(*) from public.user_organizations u
           where u.organization_id = new.organization_id
             and u.revoked_at is null) = 1 then
    update public.calendar_event_types
       set default_owner_user_id = new.user_id
     where organization_id = new.organization_id
       and default_owner_user_id is null;
  end if;
  return new;
end
$fn$;

revoke execute on function public.fn_adotar_tipos_de_agendamento_sem_dono() from public, anon, authenticated;
grant  execute on function public.fn_adotar_tipos_de_agendamento_sem_dono() to service_role;

drop trigger if exists trg_adotar_tipos_de_agendamento_sem_dono on public.user_organizations;
create trigger trg_adotar_tipos_de_agendamento_sem_dono
  after insert on public.user_organizations
  for each row execute function public.fn_adotar_tipos_de_agendamento_sem_dono();

-- Backfill: organizações que JÁ nasceram com os tipos órfãos e já têm membro. Adota o
-- membro ATIVO mais antigo — o mesmo que o trigger teria escolhido se existisse na época.
--
-- ⚠️ `revoked_at is null` nas DUAS metades, e não é detalhe: `user_organizations` guarda o
-- ex-membro em vez de apagá-lo. Sem o filtro, o backfill adotaria como dono padrão da agenda
-- alguém que já saiu da empresa — e o `exists` sem filtro faria pior, deixando o tipo órfão
-- numa org que só tem ex-membros parecer "já resolvido" por ter alguém na tabela.
update public.calendar_event_types t
   set default_owner_user_id = (
         select u.user_id from public.user_organizations u
          where u.organization_id = t.organization_id
            and u.revoked_at is null
          order by u.created_at, u.user_id
          limit 1)
 where t.default_owner_user_id is null
   and exists (select 1 from public.user_organizations u
                where u.organization_id = t.organization_id and u.revoked_at is null);
