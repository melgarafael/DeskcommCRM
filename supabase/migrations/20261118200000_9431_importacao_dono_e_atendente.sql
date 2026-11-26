-- manifest: **A importação de empresas e pessoas abre ao Atendente e passa a definir o dono da carteira (A23 parte 2, #4888).** (1) `import_batches` e `import_rows`: INSERT e UPDATE sobem de `manager` para `agent` (o DELETE continua `manager`), no mesmo passo da 9370, que já deixou o Atendente criar empresa, pessoa e vínculo. (2) `fn_definir_carteira_do_cliente`: a régua de posse do Atendente ganha UMA exceção, a importação própria — contato SEM dono, criado por ele com `source = 'import_csv'`, dono pedido = ele mesmo e origem `importacao`. Corpo idêntico ao da 9208 fora disso; continua só do service_role. (3) O UPDATE de `import_batches`/`import_rows` do Atendente vale só para o lote que ele criou (o gerente atualiza qualquer um), e um trigger impede a sessão de mudar organização, autor, nome do arquivo, tipo e data do lote.
--
-- O Atendente só é dono dele mesmo: outro dono, contato que já tinha dono ou contato
-- de outra origem continuam recusados (`carteira_fora_da_posse`). Gerente e admin
-- escolhem qualquer membro ativo.
--
-- INSERT: o lote nasce com o próprio autor em `created_by`, e a linha entra só no lote do
-- Atendente que a grava (o gerente, em qualquer um) — o mesmo escopo do UPDATE.
--
-- UPDATE: o Atendente atualiza só o lote que ele criou; a identidade do lote é imutável
-- para a sessão (trigger, no desenho da 0262).

drop policy if exists import_batches_insert on public.import_batches;
create policy import_batches_insert on public.import_batches
  for insert with check (organization_id in (select public.fn_user_org_ids())
                         and public.fn_role_at_least(organization_id, 'agent')
                         -- O autor é quem grava: nenhuma sessão forja `created_by` de outra
                         -- pessoa. `is not distinct from` e não `=`, para o lote do token de API,
                         -- que grava `created_by` nulo e não tem `auth.uid()`.
                         and created_by is not distinct from (select auth.uid()));
drop policy if exists import_batches_update on public.import_batches;
create policy import_batches_update on public.import_batches
  for update
  using (organization_id in (select public.fn_user_org_ids())
         and (public.fn_role_at_least(organization_id, 'manager')
              or (public.fn_role_at_least(organization_id, 'agent')
                  and created_by = (select auth.uid()))))
  with check (organization_id in (select public.fn_user_org_ids())
              and (public.fn_role_at_least(organization_id, 'manager')
                   or (public.fn_role_at_least(organization_id, 'agent')
                       and created_by = (select auth.uid()))));

drop policy if exists import_rows_insert on public.import_rows;
create policy import_rows_insert on public.import_rows
  for insert with check (organization_id in (select public.fn_user_org_ids())
                         -- A linha entra no lote do próprio Atendente (o gerente, em qualquer
                         -- um), o mesmo escopo do UPDATE: ele não polui o lote do colega.
                         and exists (
                           select 1 from public.import_batches b
                            where b.id = import_rows.batch_id
                              and b.organization_id = import_rows.organization_id
                              and (public.fn_role_at_least(b.organization_id, 'manager')
                                   or (public.fn_role_at_least(b.organization_id, 'agent')
                                       and b.created_by = (select auth.uid())))));
drop policy if exists import_rows_update on public.import_rows;
create policy import_rows_update on public.import_rows
  for update
  using (organization_id in (select public.fn_user_org_ids())
         and exists (
           select 1 from public.import_batches b
            where b.id = import_rows.batch_id
              and b.organization_id = import_rows.organization_id
              and (public.fn_role_at_least(b.organization_id, 'manager')
                   or (public.fn_role_at_least(b.organization_id, 'agent')
                       and b.created_by = (select auth.uid())))))
  with check (organization_id in (select public.fn_user_org_ids())
              and exists (
                select 1 from public.import_batches b
                 where b.id = import_rows.batch_id
                   and b.organization_id = import_rows.organization_id
                   and (public.fn_role_at_least(b.organization_id, 'manager')
                        or (public.fn_role_at_least(b.organization_id, 'agent')
                            and b.created_by = (select auth.uid())))));

-- O Atendente atualiza só o lote que ELE criou (o gerente, qualquer um), e nenhuma
-- sessão reescreve a identidade do lote. Trigger e não `revoke update`/`grant update
-- (colunas)`, pela razão que a 0262 registra: com grant por coluna, toda coluna criada
-- depois nasceria não-gravável em silêncio. O processador do lote escreve `status`, os
-- contadores, `total_rows` e `column_mapping` com a sessão de quem importa, então essas
-- ficam livres (no lote próprio). `auth.uid() is null` passa: é o service role (token de
-- API, LGPD, migrations).
create or replace function public.fn_colunas_do_lote_sao_do_sistema()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null
     and (old.organization_id is distinct from new.organization_id
       or old.created_by is distinct from new.created_by
       or old.filename is distinct from new.filename
       or old.kind is distinct from new.kind
       or old.created_at is distinct from new.created_at) then
    raise exception 'colunas_do_lote_sao_do_sistema' using errcode = '42501';
  end if;
  return new;
end $$;

comment on function public.fn_colunas_do_lote_sao_do_sistema() is
  'BEFORE UPDATE em import_batches: a sessão não muda organization_id, created_by, filename, kind nem created_at do lote (9431).';

drop trigger if exists trg_import_batches_colunas_do_sistema on public.import_batches;
create trigger trg_import_batches_colunas_do_sistema
  before update on public.import_batches
  for each row execute function public.fn_colunas_do_lote_sao_do_sistema();

create or replace function public.fn_definir_carteira_do_cliente(
  p_org uuid,
  p_actor uuid,
  p_contact uuid,
  p_dono uuid,
  p_origem text default 'manual'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := p_actor;
  v_papel text;
  v_dono_papel text;
  v_contato_org uuid;
  v_origem text := coalesce(p_origem, 'manual');
  v_anterior uuid;
  v_conversa uuid;
  v_dono_atual uuid;
begin
  if v_origem not in ('manual', 'importacao', 'atribuicao_automatica', 'automacao') then
    raise exception 'carteira_origem_invalida' using errcode = '22023';
  end if;
  if v_ator is null then
    -- #3514: sem ator humano, quem grava é o SISTEMA — e só ele. A automação
    -- não tem sessão; o que a identifica é a origem `automacao`, que a função
    -- recusa a quem chega com ator (senão a origem do sistema virava um rótulo
    -- que qualquer manager escolhia para esconder o próprio ato).
    if v_origem <> 'automacao' then
      raise exception 'carteira_sem_ator' using errcode = '42501';
    end if;
  end if;
  if p_org is null or p_contact is null then
    raise exception 'carteira_parametro_invalido' using errcode = '22023';
  end if;

  if v_ator is not null then
    -- Quem muda: `agent`+ da MESMA organização (e membro aceito, não revogado).
    -- #3746: o Atendente entrou nesta porta, mas com ESCOPO DE POSSE — o papel
    -- sozinho não distingue "meu cliente" de "cliente do colega", e liberar o
    -- papel seco deixaria qualquer Atendente se pôr como dono do cliente de
    -- outro e levar o negócio seguinte no nome errado (o defeito do #2591).
    select uo.role into v_papel
      from public.user_organizations uo
     where uo.user_id = v_ator
       and uo.organization_id = p_org
       and uo.accepted_at is not null
       and uo.revoked_at is null;
    if v_papel is null or v_papel not in ('agent', 'manager', 'admin') then
      raise exception 'carteira_permissao_negada'
        using errcode = '42501',
              detail = 'Só atendente, manager e admin definem a carteira do cliente.';
    end if;
    if v_papel = 'agent' then
      -- A POSSE, conferida AQUI e não só na rota: esta é a porta ÚNICA de
      -- gravação (`trg_contacts_carteira_so_pelo_servidor` recusa a sessão), e
      -- um chamador novo não pode nascer sem a régua. Doc 250, escolha 1-B:
      --   • o contato já está na carteira dele → passa (pode passar adiante);
      --   • conversa do contato atribuída a ele + contato SEM dono → passa;
      --   • conversa com ele + contato na carteira de OUTRO →
      --     `carteira_permissao_negada`: tirar o cliente de um colega segue
      --     sendo do gerente (a regra do #2591 — o rodízio não leva a venda
      --     de quem atende o cliente);
      --   • nenhuma das duas → `carteira_fora_da_posse`.
      -- A rota traduz as duas recusas em 403.
      select c.carteira_user_id into v_dono_atual
        from public.contacts c
       where c.id = p_contact
         and c.organization_id = p_org;
      -- 9431 (A23, #4888): a IMPORTAÇÃO própria. Quem importa a planilha cria o
      -- contato e o recebe na carteira: contato SEM dono, criado por ele nesta
      -- importação (`source = 'import_csv'`, `created_by_user_id` = ele) e dono
      -- pedido = ele mesmo, com a origem `importacao`. Nada mais passa por aqui:
      -- outro dono, contato que já tinha dono ou contato que veio de outro lugar
      -- seguem recusados pela régua de posse logo abaixo.
      if v_origem = 'importacao'
         and p_dono is not distinct from v_ator
         and v_dono_atual is null
         and exists (
               select 1
                 from public.contacts c
                where c.id = p_contact
                  and c.organization_id = p_org
                  and c.source = 'import_csv'
                  and c.created_by_user_id = v_ator
             ) then
        null;
      elsif v_dono_atual is distinct from v_ator then
        if not exists (
             select 1
               from public.conversations cv
              where cv.organization_id = p_org
                and cv.contact_id = p_contact
                and cv.assigned_to_user_id = v_ator
           ) then
          raise exception 'carteira_fora_da_posse'
            using errcode = '42501',
                  detail = 'O atendente só muda a carteira do cliente que já está com ele: contato na carteira dele, ou conversa atribuída a ele com o contato sem dono.';
        end if;
        if v_dono_atual is not null then
          raise exception 'carteira_permissao_negada'
            using errcode = '42501',
                  detail = 'O cliente está na carteira de outro vendedor: só manager e admin tiram o cliente da carteira de um colega.';
        end if;
      end if;
    end if;
    if v_origem = 'automacao' then
      raise exception 'carteira_origem_invalida'
        using errcode = '22023',
              detail = 'A origem automacao é do servidor, sem ator: quem chama com ator grava manual ou atribuicao_automatica.';
    end if;
  end if;

  select c.organization_id, c.carteira_user_id into v_contato_org, v_anterior
    from public.contacts c
   where c.id = p_contact;
  if v_contato_org is null then
    raise exception 'carteira_contato_nao_encontrado' using errcode = '22023';
  end if;
  if v_contato_org <> p_org then
    raise exception 'carteira_contato_de_outra_organizacao' using errcode = '42501';
  end if;

  if p_dono is not null then
    -- Quem CONTA: membro ativo da mesma org com papel de trabalho. `viewer` e
    -- membro revogado não contam — o cliente volta ao fluxo normal.
    select uo.role into v_dono_papel
      from public.user_organizations uo
     where uo.user_id = p_dono
       and uo.organization_id = p_org
       and uo.accepted_at is not null
       and uo.revoked_at is null;
    if v_dono_papel is null or v_dono_papel not in ('agent', 'manager', 'admin') then
      raise exception 'carteira_dono_invalido'
        using errcode = '22023',
              detail = 'O dono precisa ser membro ativo da mesma organização com papel agent, manager ou admin.';
    end if;
  end if;

  update public.contacts
     set carteira_user_id = p_dono,
         carteira_origem = case when p_dono is null then null else v_origem end,
         carteira_definida_em = case when p_dono is null then null else now() end,
         updated_at = now()
   where id = p_contact
     and organization_id = p_org;

  -- Os negócios ABERTOS sem dono do contato vão para o dono da carteira; os que
  -- já têm dono não mudam (ninguém perde carteira por causa de uma carteira).
  if p_dono is not null then
    update public.crm_leads
       set owner_user_id = p_dono,
           owner_kind = 'user',
           assigned_at = coalesce(assigned_at, now())
     where organization_id = p_org
       and contact_id = p_contact
       and status = 'open'
       and owner_user_id is null
       and owner_agent_id is null;

    -- ─── #3642: a carteira leva as conversas abertas ─────────────────────────
    -- Só as que estavam com o dono ANTERIOR da carteira (ou sem dono): conversa
    -- que já é de outra pessoa não é roubada por uma troca de carteira. Passa
    -- pela MESMA porta da transferência, então a conversa, o evento na linha do
    -- tempo e o número do vendedor andam juntos — e `reason` fica no vocabulário
    -- fechado da tabela de eventos ('transfer').
    if p_dono is distinct from v_anterior then
      for v_conversa in
        select c.id
          from public.conversations c
         where c.organization_id = p_org
           and c.contact_id = p_contact
           and c.status in ('open', 'pending', 'claimed', 'ai_handling')
           and (c.assigned_to_user_id is null or c.assigned_to_user_id = v_anterior)
           -- Doc 237, escolha 3-B: a conversa que a IA está atendendo fica com a
           -- IA. Quem diz isso é `comando_da_conversa` (a mesma regra da tela e
           -- do motor), não o status: a IA atende conversa `open` sem dono, e
           -- `ai_handling` quase não é escrito. Passá-la aqui a deixaria
           -- "assumida" e a IA calada sem prazo. Quando a IA passar a conversa
           -- para humano, o dono da carteira já é o vendedor novo.
           and public.comando_da_conversa(c) <> 'automatico'
         order by c.id
      loop
        perform public.fn_conversation_assign(p_org, v_conversa, p_dono, 'transfer',
          p_negocio_so_sem_dono => true);
      end loop;
    end if;
  end if;

  return p_dono;
end;
$$;

revoke execute on function public.fn_definir_carteira_do_cliente(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fn_definir_carteira_do_cliente(uuid, uuid, uuid, uuid, text)
  to service_role;
