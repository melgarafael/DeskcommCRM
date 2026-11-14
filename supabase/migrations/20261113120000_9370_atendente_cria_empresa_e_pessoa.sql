-- 9370_atendente_cria_empresa_e_pessoa
--
-- manifest: **O Atendente passa a poder CRIAR empresa, pessoa e o vínculo pessoa↔empresa (piso do INSERT: `manager` → `agent`).** A 0448 pôs `manager` nas três políticas de insert (`companies_insert`, `people_insert`, `company_people_insert`), então numa equipe só de Atendentes ninguém cadastrava o cliente novo: o formulário respondia 403 e o banco recusaria mesmo que a rota deixasse. O UPDATE dessas tabelas e o cadastro de CONTATO já eram `agent`; só a criação ficava um degrau acima — a assimetria que obrigava a passar por um Gerente a cada cliente novo. EXCLUIR continua `manager` (apagar empresa/pessoa/vínculo é destrutivo), e o escopo por organização não muda: `organization_id in fn_user_org_ids()`. Só `drop policy if exists` + `create policy` das três, mesma forma da 0448, com `'agent'` no lugar de `'manager'`. A rota, os botões e o cadastro seguido pela página da empresa (`POST /api/v1/companies/:id/contatos`) usam o mesmo piso.

drop policy if exists companies_insert on public.companies;
create policy companies_insert on public.companies
  for insert with check (organization_id in (select public.fn_user_org_ids())
                         and public.fn_role_at_least(organization_id, 'agent'));

drop policy if exists people_insert on public.people;
create policy people_insert on public.people
  for insert with check (organization_id in (select public.fn_user_org_ids())
                         and public.fn_role_at_least(organization_id, 'agent'));

drop policy if exists company_people_insert on public.company_people;
create policy company_people_insert on public.company_people
  for insert with check (organization_id in (select public.fn_user_org_ids())
                         and public.fn_role_at_least(organization_id, 'agent'));
