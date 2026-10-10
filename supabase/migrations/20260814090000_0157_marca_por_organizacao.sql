-- ============================================================================
-- 0157 — A MARCA POR ORGANIZAÇÃO, E O FIM DO READ-MODIFY-WRITE EM `settings`.
--
-- ─── Por que uma função, e não mais um `.update({settings: {...}})` ──────────
--
-- `organizations.settings` tem três donos com gates diferentes: a aba
-- Organização (admin, app/actions/settings/updateTenant.ts:56-83), o PATCH de
-- atendimento (manager, app/api/v1/settings/routing/route.ts:109-128) e a régua
-- de atrito (manager, app/api/v1/metrics/atrito/route.ts:210-228). Os três leem
-- o jsonb INTEIRO, espalham em memória e regravam o objeto inteiro, em
-- round-trips separados — sem transação, sem lock, sem versão.
--
-- A perda foi MEDIDA, não deduzida: o manager restringe `visibility_mode` de
-- 'all' para 'own'; o admin salva a aba de identidade com o snapshot velho; o
-- valor volta para 'all'. Nenhum dos dois recebe erro. E `visibility_mode` é
-- lido DIRETO pela RLS, dentro de `fn_can_view_conversation` e
-- `fn_can_view_lead`: com 'own' a função devolve f para a conversa de outro
-- dono, com 'all' devolve t. Ou seja, um write de COR reverteria, em silêncio,
-- uma decisão de exposição de dado de cliente.
--
-- `jsonb_set` numa instrução só fecha a janela: o objeto nunca sai do banco.
--
-- ─── Por que ela devolve `integer`, e não `void` ────────────────────────────
--
-- A única policy de escrita de `organizations` é `orgs_write_platform_admin`
-- (baseline.sql:3415), sem cláusula FOR — FOR ALL, USING e WITH CHECK =
-- fn_is_platform_admin(). Pelo client de sessão o UPDATE de um admin de TENANT
-- casa 0 linhas e o PostgREST responde 204 No Content: `error` chega null no
-- supabase-js, a tela diz "salvo" e nada foi gravado (issue #144). Devolver o
-- `row_count` é o que permite ao chamador distinguir "gravou" de "não gravou" —
-- informação que existe no protocolo e que a query com `.update()` sem
-- `.select()` descarta por escolha.
--
-- ─── Por que a autorização também mora AQUI ─────────────────────────────────
--
-- O gate do chamador (Server Action) usa o papel do SNAPSHOT de membership
-- carregado por `loadAuthUser()`, não re-resolvido do banco — diferente do
-- caminho de rota, que passa por `fn_user_role_in_org`. Repetir a checagem no
-- banco é o que faz a regra valer para qualquer chamador futuro, e é o que
-- impede escalação caso o EXECUTE desta função escape um dia para
-- `authenticated` (o ator vem por argumento porque o admin client não tem
-- `auth.uid()`). Essa fuga é vigiada por
-- `tests/invariants/hardening-definer-varredura.test.ts`.
--
-- ─── O CHECK que o jsonb não pode ter ───────────────────────────────────────
--
-- `accent_hex` dentro de jsonb não aceita CHECK de coluna, então a validação de
-- forma vive na função, com a MESMA regex de `platform_branding_accent_hex`:
-- `^#[0-9a-f]{6}$`, que é o que `normalizarHex` (lib/branding/rampa.ts) emite.
-- Aceitar `#FFF` criaria duas grafias da mesma cor e a pergunta "mudou?"
-- passaria a mentir.
--
-- ⚠️ Isto NÃO entra em `tests/invariants/vocabulario-banco-x-typescript.test.ts`:
-- aquele extrator só reconhece CHECK de CONJUNTO (`= ANY (ARRAY[...])`), e aqui
-- não há sequer CHECK de coluna — a regra é da função.
--
-- ─── Sem `event_log` ────────────────────────────────────────────────────────
--
-- `lib/event-log/drain.ts:4-6` só seleciona tipos COM handler registrado, e os
-- 12 de `lib/event-log/register-handlers.ts` não cobrem nada de `org.*`. Um
-- `branding.updated` nasceria `pending` para sempre em todo clone — anti-pattern
-- nº 3 do CLAUDE.md, o mesmo que `updateBranding.ts:45-51` recusou por escrito.
-- O registro desta mutação é `audit()`, que tem consumidor real (/admin/audit).
--
-- Idempotente: `create or replace function`. Nenhuma constraint nova sobre dado
-- existente, então não há o que deduplicar antes.
-- ============================================================================

create or replace function public.fn_definir_marca_da_organizacao(
  p_org   uuid,
  p_actor uuid,
  p_marca jsonb
) returns integer
    language plpgsql
    volatile
    security definer
    set search_path to 'public', 'pg_temp'
as $$
declare
  v_linhas integer;
  v_hex    text;
  v_limpar boolean;
begin
  if p_org is null or p_actor is null then
    raise exception 'marca_da_organizacao_argumento_nulo'
      using errcode = '22023';
  end if;

  -- "Apague a marca (volte ao padrão de cima)" chega por DUAS formas, e as duas
  -- significam a mesma coisa: SQL NULL (chamada direta, psql, plpgsql) e o
  -- jsonb `'null'` — NÃO MEDIDO qual das duas o PostgREST produz para um
  -- argumento jsonb recebido como `{"p_marca": null}`, e a diferença não pode
  -- decidir se o admin consegue limpar a marca. Tratar só uma delas deixaria o
  -- caminho de limpeza levantando 22023 num dos dois transportes.
  v_limpar := p_marca is null or jsonb_typeof(p_marca) = 'null';

  -- Qualquer outra coisa que não seja objeto é chamada errada: gravar um escalar
  -- em `settings.branding` faria o resolvedor ler um envelope que não existe.
  if not v_limpar and jsonb_typeof(p_marca) <> 'object' then
    raise exception 'marca_da_organizacao_forma_invalida: %', jsonb_typeof(p_marca)
      using errcode = '22023';
  end if;

  v_hex := nullif(p_marca ->> 'accent_hex', '');
  if v_hex is not null and v_hex !~ '^#[0-9a-f]{6}$' then
    raise exception 'marca_da_organizacao_accent_hex_invalido'
      using errcode = '22023';
  end if;

  -- Autorização: `admin` da PRÓPRIA organização, ou super-admin de plataforma.
  -- Falha ALTO (exceção), não devolvendo 0: 0 tem outro significado abaixo
  -- ("a organização não existe"), e colapsar os dois deixaria o chamador sem
  -- saber se o problema é papel ou id.
  if not exists (
       select 1 from public.user_organizations uo
        where uo.user_id = p_actor
          and uo.organization_id = p_org
          and uo.role = 'admin'
          and uo.revoked_at is null
     )
     and not exists (
       select 1 from public.platform_admins pa
        where pa.user_id = p_actor
          and pa.revoked_at is null
     )
  then
    raise exception 'marca_da_organizacao_sem_permissao'
      using errcode = '42501';
  end if;

  update public.organizations o
     set settings = case
           when v_limpar
             then coalesce(o.settings, '{}'::jsonb) - 'branding'
           else jsonb_set(coalesce(o.settings, '{}'::jsonb), '{branding}', p_marca, true)
         end
   where o.id = p_org;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$$;

comment on function public.fn_definir_marca_da_organizacao(uuid, uuid, jsonb) is
  'Grava organizations.settings.branding com merge ATÔMICO (jsonb_set), sem tocar nas demais chaves do jsonb (llm, routing, visibility_mode, atrito, ai_dispatch_mode, canonical_conversation_tags, lost_reasons_extra, plan). Devolve linhas afetadas: 0 = a organização não existe. Papel insuficiente levanta 42501. Chamador: app/actions/settings/updateMarcaDaOrganizacao.ts.';

-- ── OS DOIS REVOKES (CLAUDE.md, item 9) — são origens distintas de EXECUTE ──
--
-- (A) `from public`: o grant que o Postgres dá a PUBLIC ao criar QUALQUER
--     função. `revoke ... from anon` NÃO o remove.
-- (B) `from anon`: o grant DIRETO do `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON
--     FUNCTIONS TO anon` que o baseline traz (linha ~3972) e que todo projeto
--     Supabase já tem em `pg_default_acl` antes de qualquer SQL nosso — vale
--     para toda função criada depois dele, isto é, para todo apêndice novo.
--     `revoke ... from public` NÃO o remove.
--
-- `from authenticated` pelo mesmo motivo de (B) e mais um: esta função é
-- VOLÁTIL (escreve). Definer volátil alcançável por qualquer usuário logado é
-- escrita cross-tenant, e é a segunda regra de
-- tests/invariants/hardening-definer-varredura.test.ts. O único chamador é o
-- admin client (service_role).
revoke execute on function public.fn_definir_marca_da_organizacao(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.fn_definir_marca_da_organizacao(uuid, uuid, jsonb)
  to service_role;

notify pgrst, 'reload schema';
