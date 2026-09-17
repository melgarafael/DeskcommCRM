-- A ocupação do Google Agenda do DONO da agenda não depende de quem consulta
-- (issue #879, PR #883).
--
-- ─── O defeito ───────────────────────────────────────────────────────────────
--
-- A coleta de horários (`lib/agenda/consulta.ts`) chegava aos eventos do Google
-- por `calendar_selected_external_events` com o embed
-- `calendar_connections!inner(user_id, status)`, filtrando pelo dono da agenda.
-- A RLS de `calendar_connections` (`calendar_connections_dono_ou_manager_read`)
-- mostra a conexão só ao PRÓPRIO dono e a `manager` para cima — e com razão:
-- a tabela guarda token OAuth. Com o client de SESSÃO de um `agent` marcando na
-- agenda de outra pessoa, a junção voltava vazia e o Google do dono sumia da
-- conta. Medido na triagem num Postgres descartável com o `baseline.sql`: a
-- MESMA agenda rende 1 evento para o dono, 1 para o gerente e 0 para o
-- atendente. A tela oferecia, e a escrita aceitava, horário em cima de um
-- compromisso pessoal que existe — pela grade (GET de horários) e pelo encaixe
-- fora da grade (`exigeSemSobreposicao`), que leem a mesma coleta.
--
-- ─── Por que função, e não o client admin na rota ────────────────────────────
--
-- O PR resolvia lendo as duas tabelas com `createAdminClient()` dentro da
-- coleta. `lib/supabase/admin.ts` proíbe service role em rota acionada por
-- usuário em fluxo normal, e o GET de horários É o fluxo normal. Além disso o
-- admin ficava ESCONDIDO dentro de uma função que recebe o client de fora: quem
-- passa o client de sessão acreditando que a RLS protege recebia, sem saber, uma
-- leitura com service role cuja única guarda era o `.eq("organization_id")`.
--
-- A função abaixo dá o mesmo desfecho com o privilégio no lugar certo:
--   · `security definer` para atravessar SÓ a RLS da conexão;
--   · o pertencimento é conferido NO CORPO (`fn_user_org_ids()`, a mesma régua
--     das policies) — o `p_org` do argumento é filtro, não fronteira;
--   · o dono é filtro explícito (`c.user_id = p_owner`);
--   · o que volta é ocupação e nada mais: início, fim, `transparency`, `status`
--     do evento e a situação da conexão. Nenhum título, descrição, participante,
--     id externo ou token. Quem decide o que ocupa continua sendo o TypeScript
--     (`ocupadosDoDono`), por isso `transparency`/`status` vêm crus;
--   · `auth.uid() is null` é chamada SEM `sub` no JWT — na prática o
--     `service_role` (ferramenta MCP, worker): um JWT `authenticated` sem `sub`
--     só se forja com o segredo, e quem o tem já tem o `service_role`. É o mesmo
--     desenho de `fn_google_coverage`. `anon` não chega: EXECUTE revogado das
--     duas origens.
--   · `fn_is_platform_admin()` preserva, na função de CONEXÕES, o que a policy
--     da conexão já dava ao suporte da plataforma. Na de OCUPAÇÃO o ramo não
--     muda nada hoje (a view já filtra por pertencimento; medido pelo cético do
--     lote 10: platform admin sem suporte lê 0 antes e depois).
--
-- A segunda função é a mesma pergunta sobre a CONEXÃO (`status`,
-- `last_sync_at`), que decide `agendaExternaNuncaLida`: "não tem Google" e "tem
-- Google que nunca foi lido" são opostos, e para o atendente os dois viravam
-- "não tem Google".
--
-- `calendar_selected_external_events` é view `security_invoker`: dentro da
-- definer ela roda com o dono da função, e o filtro de seleção
-- (`fn_google_counts_for_conflicts`) continua valendo — ele confere o
-- pertencimento pelo `auth.uid()` do JWT, que a definer não troca.
--
-- Sem coluna, sem constraint, sem backfill. Gate:
-- `tests/invariants/agenda-ocupacao-google-do-dono.test.ts` (dono, gerente e
-- atendente veem o mesmo; outra organização e `anon` não veem; a função não
-- devolve título).

create or replace function public.fn_agenda_ocupacao_google_do_dono(
  p_org uuid,
  p_owner uuid,
  p_de timestamptz,
  p_ate timestamptz
)
returns table (
  starts_at timestamptz,
  ends_at timestamptz,
  transparency text,
  status text,
  connection_status text
)
language sql
stable
security definer
set search_path = public
as $$
  select e.starts_at, e.ends_at, e.transparency, e.status, c.status
    from public.calendar_selected_external_events e
    join public.calendar_connections c
      on c.organization_id = e.organization_id
     and c.id = e.connection_id
   where (auth.uid() is null
          or p_org in (select public.fn_user_org_ids())
          or public.fn_is_platform_admin())
     and e.organization_id = p_org
     and c.user_id = p_owner
     -- Cruzamento ESTRITO, a régua de `colide`: encostar não é ocupar.
     and e.starts_at < p_ate
     and e.ends_at > p_de;
$$;

create or replace function public.fn_agenda_conexoes_google_do_dono(
  p_org uuid,
  p_owner uuid
)
returns table (
  status text,
  last_sync_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select c.status, c.last_sync_at
    from public.calendar_connections c
   where (auth.uid() is null
          or p_org in (select public.fn_user_org_ids())
          or public.fn_is_platform_admin())
     and c.organization_id = p_org
     and c.user_id = p_owner;
$$;

-- Função nova em `public` nasce EXPOSTA — as DUAS origens de EXECUTE (CLAUDE.md):
-- (A) o `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon` do
--     baseline, que `revoke from public` NÃO remove;
-- (B) o grant a PUBLIC que o Postgres dá a toda função criada, que
--     `revoke from anon` NÃO remove.
revoke execute on function public.fn_agenda_ocupacao_google_do_dono(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant  execute on function public.fn_agenda_ocupacao_google_do_dono(uuid, uuid, timestamptz, timestamptz) to authenticated, service_role;
revoke execute on function public.fn_agenda_conexoes_google_do_dono(uuid, uuid) from public, anon;
grant  execute on function public.fn_agenda_conexoes_google_do_dono(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
