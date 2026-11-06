import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * #3090 — a caixa de entrada não pode custar por linha no RLS.
 *
 * A policy `conversations_select` chamava `fn_can_view_conversation(organization_id,
 * assigned_to_user_id)` em TODA linha candidata; aquela função é `security definer
 * set search_path = public` e refaz `fn_user_role_in_org()` até duas vezes por
 * linha, que por sua vez refaz `fn_support_context()`. Medido (Postgres 15 e 17,
 * baseline instalado, 142 conversas, um agente): contar a fila levava ~220 ms e
 * crescia com o número de conversas. Agora o escopo é resolvido em conjunto
 * (`fn_conversation_scope()`), uma vez por consulta: ~5 ms.
 *
 * Este arquivo prende as DUAS pontas do conserto:
 *
 *  1. a VISIBILIDADE é idêntica à da regra antiga — pessoa por pessoa, o que a
 *     policy devolve é o mesmo que a `fn_can_view_conversation` devolve (ela segue
 *     sendo a fonte da verdade da escada para os outros consumidores; se as duas
 *     divergirem no futuro, este teste fica vermelho);
 *  2. o CUSTO não é mais por linha — o plano não chama a função por linha e a
 *     função de escopo roda uma vez por disjunção, não uma vez por conversa.
 *
 * O segundo item é o que uma regressão de desempenho quebra: devolver a policy ao
 * estado por linha NÃO muda quem vê o quê (o item 1 continua verde) e derruba os
 * casos de plano e de tempo. Foi sabotado e conferido na triagem: a policy por
 * linha derruba os casos de plano e de tempo; o atalho mode <> own derruba os de
 * visibilidade.
 *
 * Namespace 99999999 (cada invariante tem banco próprio; followup-schema.test.ts
 * usa o mesmo prefixo sem colidir).
 */

const ORG_PERF = "99999999-0000-4000-8000-000000000001"; // settings ausente (=G1-06a)
const ORG_PADRAO = "99999999-0000-4000-8000-000000000002"; // settings {} (default)
const ORG_ALL = "99999999-0000-4000-8000-000000000003"; // visibility_mode = 'all'
const ORG_OWN = "99999999-0000-4000-8000-000000000004"; // visibility_mode = 'own'
const ORG_LIXO = "99999999-0000-4000-8000-000000000005"; // visibility_mode inválido

const AGENTE = "99999999-1111-4000-8000-000000000001";
const OBSERVADOR = "99999999-1111-4000-8000-000000000002";
const GERENTE = "99999999-1111-4000-8000-000000000003";
const DONO = "99999999-1111-4000-8000-000000000004";
const FORASTEIRO = "99999999-1111-4000-8000-000000000005";
const PLATAFORMA = "99999999-1111-4000-8000-000000000006";

const SESSOES: Record<string, string> = {
  [ORG_PERF]: "99999999-2222-4000-8000-000000000001",
  [ORG_PADRAO]: "99999999-2222-4000-8000-000000000002",
  [ORG_ALL]: "99999999-2222-4000-8000-000000000003",
  [ORG_OWN]: "99999999-2222-4000-8000-000000000004",
  [ORG_LIXO]: "99999999-2222-4000-8000-000000000005",
};

/** Quantas conversas a instalação pequena do relato tinha — o número da dor. */
const CONVERSAS_DA_DOR = 142;

/** O teto do item 3, em ms. Medido depois: ~5 ms (pg15/pg17); antes: ~220 ms. */
const TETO_MS = 60;

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name, settings) values
      ('${ORG_PERF}',   's9999-perf',   'S9999 Perf',   'S9999 Perf',   '{}'::jsonb),
      ('${ORG_PADRAO}', 's9999-padrao', 'S9999 Padrao', 'S9999 Padrao', '{}'::jsonb),
      ('${ORG_ALL}',    's9999-tudo',   'S9999 Tudo',   'S9999 Tudo',   '{"visibility_mode":"all"}'::jsonb),
      ('${ORG_OWN}',    's9999-proprio','S9999 Proprio','S9999 Proprio','{"visibility_mode":"own"}'::jsonb),
      ('${ORG_LIXO}',   's9999-lixo',   'S9999 Lixo',   'S9999 Lixo',   '{"visibility_mode":"lixo"}'::jsonb)
    on conflict (id) do nothing;

    insert into auth.users (id, email) values
      ('${AGENTE}',    'agente@s9999.test'),
      ('${OBSERVADOR}','observador@s9999.test'),
      ('${GERENTE}',   'gerente@s9999.test'),
      ('${DONO}',      'dono@s9999.test'),
      ('${FORASTEIRO}','forasteiro@s9999.test'),
      ('${PLATAFORMA}','plataforma@s9999.test')
    on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role)
    select u.uid, o.oid, u.papel
      from (values
        ('${AGENTE}'::uuid, 'agent'),
        ('${OBSERVADOR}'::uuid, 'viewer'),
        ('${GERENTE}'::uuid, 'manager'),
        ('${DONO}'::uuid, 'admin')
      ) as u(uid, papel)
      cross join (values ('${ORG_PERF}'::uuid), ('${ORG_PADRAO}'::uuid),
                         ('${ORG_ALL}'::uuid), ('${ORG_OWN}'::uuid), ('${ORG_LIXO}'::uuid)) as o(oid)
    on conflict do nothing;

    -- O forasteiro NÃO é membro de organização nenhuma: é o caso que a alínea
    -- "não é membro ⇒ nada" precisa cobrir (nenhuma disjunção pode casar por ele).
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason)
    values ('${PLATAFORMA}', '${DONO}', 'full', false, 'fixture do invariante #3090')
    on conflict (user_id) do nothing;

    insert into public.channel_sessions (id, organization_id, webhook_secret_encrypted, waha_session_name)
    values ${Object.entries(SESSOES)
      .map(([org, sessao]) => `('${sessao}', '${org}', '\\x00'::bytea, 's9999-${sessao.slice(-4)}')`)
      .join(",\n           ")}
    on conflict (id) do nothing;
  `);

  // ORG_PERF: 142 conversas (57 do agente, 71 do dono, 14 sem responsável — o
  // padrão da instalação do relato); e 3 linhas em cada organização da matriz
  // (1 do agente, 1 de outro, 1 sem responsável).
  sql(`
    insert into public.contacts (id, organization_id, name)
    select ('99999999-c' || lpad(o.org::text, 3, '0') || '-4000-8000-' || lpad(g.i::text, 12, '0'))::uuid,
           o.organization_id, 'Contato ' || o.org || '-' || g.i
      from (values
        ('${ORG_PERF}'::uuid, 0, ${CONVERSAS_DA_DOR}),
        ('${ORG_PADRAO}'::uuid, 1, 3),
        ('${ORG_ALL}'::uuid, 2, 3),
        ('${ORG_OWN}'::uuid, 3, 3),
        ('${ORG_LIXO}'::uuid, 4, 3)
      ) as o(organization_id, org, total)
      cross join lateral generate_series(1, o.total) as g(i)
    on conflict (id) do nothing;

    insert into public.conversations (organization_id, contact_id, channel_session_id, assigned_to_user_id)
    select o.organization_id,
           ('99999999-c' || lpad(o.org::text, 3, '0') || '-4000-8000-' || lpad(g.i::text, 12, '0'))::uuid,
           o.channel_session_id,
           case
             when o.org = 0 and g.i % 10 = 0 then null                    -- a fila sem responsável
             when o.org = 0 and g.i % 2 = 0 then '${AGENTE}'::uuid        -- 57 do agente
             when o.org = 0 then '${DONO}'::uuid                          -- 71 do dono
             when g.i = 1 then '${AGENTE}'::uuid
             when g.i = 2 then '${DONO}'::uuid
             else null
           end
      from (values
        ('${ORG_PERF}'::uuid, 0, '${SESSOES[ORG_PERF]}'::uuid, ${CONVERSAS_DA_DOR}),
        ('${ORG_PADRAO}'::uuid, 1, '${SESSOES[ORG_PADRAO]}'::uuid, 3),
        ('${ORG_ALL}'::uuid, 2, '${SESSOES[ORG_ALL]}'::uuid, 3),
        ('${ORG_OWN}'::uuid, 3, '${SESSOES[ORG_OWN]}'::uuid, 3),
        ('${ORG_LIXO}'::uuid, 4, '${SESSOES[ORG_LIXO]}'::uuid, 3)
      ) as o(organization_id, org, channel_session_id, total)
      cross join lateral generate_series(1, o.total) as g(i);
  `);
});

/** O que a POLICY devolve: role authenticated + claims, igual ao PostgREST. */
function visiveisPelaPolicy(userId: string): string {
  return sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    select coalesce(string_agg(id::text, ',' order by id), '-') from public.conversations;
  `)
    .split("\n")
    .pop() as string;
}

/** O que a FUNÇÃO devolve, com os MESMOS claims: a escada por linha, como referência. */
function visiveisPelaFuncao(userId: string): string {
  return sql(`
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    select coalesce(string_agg(id::text, ',' order by id), '-')
      from public.conversations
     where public.fn_can_view_conversation(organization_id, assigned_to_user_id);
  `)
    .split("\n")
    .pop() as string;
}

/** Quantas conversas a policy mostra (o `count(*)` da caixa de entrada). */
function contarPelaPolicy(userId: string): number {
  return Number(
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
      select count(*) from public.conversations;
    `)
      .split("\n")
      .pop(),
  );
}

/** O plano (formato json) da consulta de contagem, como o usuário a roda. */
function planoDaContagem(userId: string): { texto: string; execucaoMs: number } {
  const saida = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    explain (analyze, format json, costs off) select count(*) from public.conversations;
  `);
  const json = JSON.parse(saida.slice(saida.indexOf("["))) as Array<Record<string, unknown>>;
  return {
    texto: JSON.stringify(json),
    execucaoMs: Number(json[0]?.["Execution Time"] ?? Number.NaN),
  };
}

describe("#3090 — escopo da conversa avaliado uma vez, não por linha", () => {
  it("a policy e a fn_can_view_conversation concordam pessoa por pessoa", () => {
    // A escada antiga continua sendo a régua: a policy nova tem de devolver o
    // MESMO conjunto, para cada papel e cada modo de visibilidade.
    for (const usuario of [AGENTE, OBSERVADOR, GERENTE, DONO, FORASTEIRO, PLATAFORMA]) {
      const pelaPolicy = visiveisPelaPolicy(usuario).split(",");
      const pelaFuncao = visiveisPelaFuncao(usuario).split(",");
      expect([usuario, pelaPolicy]).toEqual([usuario, pelaFuncao]);
    }
  });

  it("pina a escada em números explícitos (dono, membro, observador, forasteiro)", () => {
    // 154 conversas seedadas: 142 na organização do relato + 3 em cada uma das 4
    // organizações de modo. Os números abaixo não vêm da função — são a leitura
    // da spec 13 §4 (agent = own*; viewer/manager/admin = org-wide;
    // 'own_and_unassigned' inclui a fila sem responsável; o resto só o próprio).
    expect(contarPelaPolicy(AGENTE)).toBe(57 + 14 + 2 + 3 + 1 + 1); // 78
    expect(contarPelaPolicy(OBSERVADOR)).toBe(142 + 12); // org-wide: 154
    expect(contarPelaPolicy(GERENTE)).toBe(142 + 12);
    expect(contarPelaPolicy(DONO)).toBe(142 + 12);
    expect(contarPelaPolicy(FORASTEIRO)).toBe(0); // não é membro de nada
    expect(contarPelaPolicy(PLATAFORMA)).toBe(154); // a plataforma vê tudo
  });

  it("o plano não chama fn_can_view_conversation por linha", () => {
    const { texto } = planoDaContagem(AGENTE);
    // O defeito do #3090 é esta chamada, uma vez por linha candidata.
    expect(texto).not.toContain("fn_can_view_conversation");
    // O conserto é esta função, resolvida em conjunto antes do scan.
    expect(texto).toContain("fn_conversation_scope");
  });

  it("a função de escopo roda 3 vezes por consulta, não 154 (uma por conversa)", () => {
    // Substitui a policy de PRODUÇÃO pela MESMA forma da migration, com uma sonda
    // `volatile` no lugar da função (uma linha gravada por EXECUÇÃO) e mede a
    // consulta da caixa de entrada com 154 conversas candidatas. Volatile é o caso
    // mais difícil de propósito — o planejador não pode memoizar nem pular uma
    // sonda volatile. Tudo dentro de uma transação: o rollback devolve a policy de
    // produção, então este caso não altera nada do que os outros medem.
    const sonda = (forma: "por_consulta" | "por_linha"): { visiveis: number; execucoes: number } => {
      const policy =
        forma === "por_consulta"
          ? `(select public.fn_is_platform_admin())
             or organization_id in (select s.organization_id from public.tmp_sonda_3090_por_consulta() s
                                     where s.org_wide_read)
             or (assigned_to_user_id = auth.uid()
                 and organization_id in (select s.organization_id from public.tmp_sonda_3090_por_consulta() s))
             or (assigned_to_user_id is null
                 and organization_id in (select s.organization_id from public.tmp_sonda_3090_por_consulta() s
                                          where s.sees_unassigned))`
          : `public.tmp_sonda_3090_por_linha(organization_id, assigned_to_user_id)`;

      const saida = sql(`
        begin;
        create table public.tmp_sonda_3090 (pid int);
        create function public.tmp_sonda_3090_por_consulta()
        returns table (organization_id uuid, org_wide_read boolean, sees_unassigned boolean)
        language plpgsql volatile security definer set search_path = public as $sonda$
        begin
          insert into public.tmp_sonda_3090 values (pg_backend_pid());
          return query select o.organization_id,
                              public.fn_user_role_in_org(o.organization_id) in ('viewer','manager','admin')
                                or coalesce((select z.settings->>'visibility_mode' from public.organizations z
                                             where z.id = o.organization_id), 'own_and_unassigned') = 'all',
                              coalesce((select z.settings->>'visibility_mode' from public.organizations z
                                        where z.id = o.organization_id), 'own_and_unassigned') = 'own_and_unassigned'
                         from public.fn_user_org_ids() as o(organization_id);
        end $sonda$;
        create function public.tmp_sonda_3090_por_linha(p_org uuid, p_assigned uuid)
        returns boolean language plpgsql volatile security definer set search_path = public as $sonda$
        begin
          insert into public.tmp_sonda_3090 values (pg_backend_pid());
          return true;
        end $sonda$;
        grant execute on function public.tmp_sonda_3090_por_consulta() to authenticated;
        grant execute on function public.tmp_sonda_3090_por_linha(uuid, uuid) to authenticated;
        select set_config('request.jwt.claims', '{"sub":"${AGENTE}"}', false);

        drop policy "conversations_select" on public.conversations;
        create policy "conversations_select" on public.conversations for select using (${policy});

        delete from public.tmp_sonda_3090;
        set role authenticated;
        select 'visiveis=' || count(*) from public.conversations;
        reset role;
        select 'execucoes=' || count(*) from public.tmp_sonda_3090;
        rollback;
      `);

      return {
        visiveis: Number(/visiveis=(\d+)/.exec(saida)?.[1]),
        execucoes: Number(/execucoes=(\d+)/.exec(saida)?.[1]),
      };
    };

    // A forma nova: três avaliações (uma por disjunção) para 154 conversas.
    expect(sonda("por_consulta")).toEqual({ visiveis: 78, execucoes: 3 });
    // A forma antiga (o defeito): uma avaliação por LINHA candidata — 154, e o
    // custo cresce com o tamanho da caixa de entrada.
    expect(sonda("por_linha")).toEqual({ visiveis: 154, execucoes: 154 });
  });

  it(`conta ${CONVERSAS_DA_DOR} conversas sem pagar por linha (teto de ${TETO_MS} ms)`, () => {
    // Antes do conserto, esta consulta levava ~220 ms e subia com o número de
    // conversas; com o conserto, ~5 ms. O teto é generoso de propósito (o alvo é
    // uma ordem de grandeza, não um piso de máquina): o que ele pega é a volta do
    // custo por linha.
    const tempos = [0, 1, 2].map(() => planoDaContagem(AGENTE).execucaoMs);
    const melhor = Math.min(...tempos);
    expect(Number.isFinite(melhor)).toBe(true);
    expect(melhor, `tempos medidos: ${tempos.join(", ")} ms`).toBeLessThan(TETO_MS);
  });
});
