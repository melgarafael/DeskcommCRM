import { execFileSync, spawnSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * A COBRANÇA AVULSA NÃO CRUZA TENANT — E "PAGO" NÃO SE ESCREVE PELA SESSÃO.
 *
 * ═══ O que este arquivo mede, e por que ele existe separado ═══
 *
 * A migration 9345 cria `cobrancas_avulsas`: valor, vencimento e estado presos a
 * um negócio (`crm_leads`) e/ou a uma conversa (`conversations`). São quatro
 * cercas, e cada uma tem um jeito diferente de falhar:
 *
 *   1. LEITURA  — a policy de SELECT por `fn_user_org_ids()`; sem ela o vizinho
 *      lê quanto a empresa cobra de quem e quando vence.
 *   2. ESCRITA  — a policy de INSERT/UPDATE/DELETE por organização; sem ela o
 *      vizinho emite cobrança NA conta da outra empresa.
 *   3. ÂNCORA   — `organization_id` da linha bate com o do negócio/conversa? A
 *      policy sozinha NÃO vê isto: ela filtra a coluna da própria linha, então
 *      um INSERT com organização A e negócio de B passa na RLS e a cobrança de A
 *      aponta para o negócio do vizinho (o buraco que a 0464 fechou em
 *      `crm_proposal_items`). Quem recusa é o gatilho de consistência.
 *   4. DINHEIRO — sem gateway nesta fatia, "recebi" é uma pessoa olhando o
 *      extrato. Com a anon key + JWT do atendente o PostgREST alcança a tabela
 *      direto; um PATCH `estado: 'paga'` seria um recebimento sem dinheiro. O
 *      gatilho recusa a sessão, e o `service_role` — o único caminho do servidor
 *      — segue podendo, que é o controle positivo da cerca.
 *
 * Conectar como `postgres` mediria NADA (`rolbypassrls = t`). O caminho daqui é
 * `set role authenticated` + `request.jwt.claims`, o mesmo de produção — exceto
 * nas cercas 3 e 4, onde o bypass é justamente o que se quer (provar que a
 * consistência de tenant e o "pago" NÃO dependem da RLS).
 *
 * ═══ Por que não é uma linha em `rls-isolation.test.ts` ═══
 *
 * A tabela FOI acrescentada lá (a lista `TABLES` daquele arquivo é a varredura
 * de comportamento por tabela, e ela já roda `cobrancas_avulsas` nas duas
 * direções). O que não cabia lá é o resto: âncora de outro tenant, transição de
 * estado e gate de papel na exclusão não são "linha de tabela isolada", são
 * regras de negócio — e o molde daquele arquivo só sabe contar linhas.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

/** Roda um script SQL numa sessão psql única; falha do banco derruba o teste. */
function sql(script: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      containerName,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      "-f",
      "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

/**
 * Roda um script que TEM de falhar e devolve o stderr do psql.
 *
 * `spawnSync` e não `try/catch` de `execFileSync`: o `catch` também pegaria o
 * meu próprio `throw` de "esperava erro e passou", e o teste passaria com a
 * cerca ABERTA — o modo de falha que este arquivo existe para não ter.
 */
function sqlEsperandoErro(script: string): string {
  const r = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      containerName,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      "-f",
      "-",
    ],
    { input: script, encoding: "utf8" },
  );
  if (r.status === 0) {
    throw new Error(`esperava erro do banco e o script passou:\n${script}`);
  }
  return `${r.stderr ?? ""}`;
}

const ORG_A = "c0b0a000-0000-4000-8000-000000000001";
const ORG_B = "c0b0b000-0000-4000-8000-000000000002";
const USER_A = "c0b0a111-0000-4000-8000-000000000001";
const USER_B = "c0b0b111-0000-4000-8000-000000000002";
const SESS_A = "c0b0a222-0000-4000-8000-000000000001";
const SESS_B = "c0b0b222-0000-4000-8000-000000000002";

/** Executa `corpo` como a sessão de `userId` — role + claims, como o PostgREST. */
function comoUsuario(userId: string, corpo: string): string {
  return sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${corpo}
  `);
}

function comoUsuarioEsperandoErro(userId: string, corpo: string): string {
  return sqlEsperandoErro(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${corpo}
  `);
}

/** A última linha numérica do psql (o `set_config` também ecoa). */
function ultimoNumero(saida: string): number {
  const linhas = saida.split("\n").filter((l) => /^\d+$/.test(l.trim()));
  const ultima = linhas[linhas.length - 1];
  if (ultima === undefined) throw new Error(`saída inesperada do psql: ${saida}`);
  return Number(ultima);
}

/** Id do negócio de cada organização, para as sondas de âncora. */
let leadA = "";
let leadB = "";
let conversaB = "";
let contatoB = "";

beforeAll(() => {
  // Sem PII real: nomes e e-mails sintéticos (LGPD).
  for (const [org, user, sess, tag] of [
    [ORG_A, USER_A, SESS_A, "a"],
    [ORG_B, USER_B, SESS_B, "b"],
  ] as const) {
    sql(`
      insert into auth.users (id, email) values ('${user}', 'cobranca-avulsa-${tag}@invariant.test')
        on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${org}', 'cobranca-avulsa-${tag}', 'Cobranca Avulsa ${tag}', 'Cobranca ${tag}')
        on conflict (id) do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${user}', '${org}', 'agent', now())
        on conflict do nothing;
      insert into public.channel_sessions
        (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${sess}', '${org}', 'cobranca-avulsa-${tag}', '\\x00'::bytea)
        on conflict (id) do nothing;
    `);
  }

  sql(`
    do $seed$
    declare
      v_org uuid;
      v_sess uuid;
      v_contact uuid;
      v_conv uuid;
      v_pipe uuid;
      v_stage uuid;
    begin
      foreach v_org in array array['${ORG_A}'::uuid, '${ORG_B}'::uuid] loop
        select id into v_sess from public.channel_sessions where organization_id = v_org;

        select id into v_contact from public.contacts
          where organization_id = v_org and display_name = 'Cobranca Avulsa Contato';
        if v_contact is null then
          insert into public.contacts (organization_id, display_name)
            values (v_org, 'Cobranca Avulsa Contato') returning id into v_contact;
        end if;

        select id into v_conv from public.conversations
          where organization_id = v_org and contact_id = v_contact;
        if v_conv is null then
          insert into public.conversations (organization_id, contact_id, channel_session_id)
            values (v_org, v_contact, v_sess) returning id into v_conv;
        end if;

        select id into v_pipe from public.crm_pipelines
          where organization_id = v_org and slug = 'cobranca-avulsa';
        if v_pipe is null then
          insert into public.crm_pipelines (organization_id, name, slug)
            values (v_org, 'Cobranca Avulsa', 'cobranca-avulsa') returning id into v_pipe;
        end if;

        select id into v_stage from public.crm_stages
          where organization_id = v_org and pipeline_id = v_pipe and slug = 'novo';
        if v_stage is null then
          insert into public.crm_stages (organization_id, pipeline_id, name, slug, position)
            values (v_org, v_pipe, 'Novo', 'novo', 1000) returning id into v_stage;
        end if;

        if not exists (select 1 from public.crm_leads where organization_id = v_org) then
          insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, contact_id)
            values (v_org, v_pipe, v_stage, 'Cobranca Avulsa Negocio', v_contact);
        end if;
      end loop;
    end
    $seed$;
  `);

  // `limit 1` por subconsulta, e não join: o join por organization_id viraria
  // produto cartesiano entre conversas e contatos, e a linha escolhida passaria
  // a depender da ordem do plano — semente que "às vezes" pega o vizinho é pior
  // que semente nenhuma.
  const ids = sql(`
    select '${ORG_A}',
           (select id from public.crm_leads where organization_id = '${ORG_A}' limit 1),
           (select id from public.conversations where organization_id = '${ORG_A}' limit 1),
           (select id from public.contacts where organization_id = '${ORG_A}' limit 1)
    union all
    select '${ORG_B}',
           (select id from public.crm_leads where organization_id = '${ORG_B}' limit 1),
           (select id from public.conversations where organization_id = '${ORG_B}' limit 1),
           (select id from public.contacts where organization_id = '${ORG_B}' limit 1);
  `);
  const [linhaA, linhaB] = ids.split("\n");
  if (!linhaA || !linhaB) throw new Error(`seed sem as duas organizações: ${ids}`);
  const [orgDaLinhaA, idLeadA, , idContatoA] = linhaA.split("|");
  const [orgDaLinhaB, idLeadB, idConvB, idContatoB] = linhaB.split("|");
  if (orgDaLinhaA !== ORG_A || orgDaLinhaB !== ORG_B) {
    throw new Error(`semente fora de ordem: ${ids}`);
  }
  leadA = idLeadA!;
  leadB = idLeadB!;
  conversaB = idConvB!;
  contatoB = idContatoB!;
});

describe("cobrancas_avulsas — âncora, estado e isolamento", () => {
  it("semente: as duas organizações têm negócio, conversa e contato", () => {
    const n = ultimoNumero(
      sql(`
        select count(distinct organization_id) from public.crm_leads
         where organization_id in ('${ORG_A}', '${ORG_B}');
      `),
    );
    expect(n).toBe(2);
    expect(leadA).not.toBe(leadB);
  });

  it("a sessão emite a cobrança do PRÓPRIO negócio: nasce pendente", () => {
    const saida = comoUsuario(
      USER_A,
      `insert into public.cobrancas_avulsas
         (organization_id, lead_id, descricao, valor_cents, vencimento)
       values ('${ORG_A}', '${leadA}', 'Entrada do projeto', 150000, '2026-12-10')
       returning organization_id, estado, valor_cents;`,
    );
    expect(saida).toContain(`${ORG_A}|pendente|150000`);

    expect(
      comoUsuario(USER_A, `select count(*) from public.cobrancas_avulsas where organization_id = '${ORG_A}';`),
    ).toMatch(/^1$/m);
  });

  it("o vizinho NÃO lê a cobrança do outro tenant", () => {
    const contagem = ultimoNumero(
      comoUsuario(
        USER_B,
        `select count(*) from public.cobrancas_avulsas where organization_id = '${ORG_A}';`,
      ),
    );
    expect(contagem).toBe(0);

    // Controle positivo: B tem a própria linha, semeada pela própria sessão.
    comoUsuario(
      USER_B,
      `insert into public.cobrancas_avulsas
         (organization_id, conversation_id, contact_id, descricao, valor_cents)
       values ('${ORG_B}', '${conversaB}', '${contatoB}', 'Sinal do orcamento', 5000);`,
    );
    expect(
      ultimoNumero(
        comoUsuario(
          USER_B,
          `select count(*) from public.cobrancas_avulsas where organization_id = '${ORG_B}';`,
        ),
      ),
    ).toBe(1);
  });

  it("o vizinho NÃO escreve na organização do outro (policy de INSERT)", () => {
    // `leadA`, e não `leadB`: com negócio do vizinho quem recusa primeiro é o
    // gatilho de consistência (BEFORE ROW roda antes do WITH CHECK da policy), e
    // a sonda mediria a cerca 3 achando que mediu a cerca 2. Com a âncora
    // legítima da org A, só a policy de INSERT pode barrar.
    const erro = comoUsuarioEsperandoErro(
      USER_B,
      `insert into public.cobrancas_avulsas
         (organization_id, lead_id, descricao, valor_cents)
       values ('${ORG_A}', '${leadA}', 'cobranca do vizinho', 100);`,
    );
    expect(erro).toMatch(/row-level security/i);
    expect(
      ultimoNumero(
        comoUsuario(
          USER_A,
          `select count(*) from public.cobrancas_avulsas where organization_id = '${ORG_A}';`,
        ),
      ),
    ).toBe(1);
  });

  it("âncora de OUTRO tenant é recusada mesmo com service_role (gatilho)", () => {
    // É esta a sonda que a RLS não faz: a coluna da linha é A, então a policy
    // passaria; quem recusa é a consistência contra crm_leads.organization_id.
    const negocio = sqlEsperandoErro(`
      insert into public.cobrancas_avulsas
        (organization_id, lead_id, descricao, valor_cents)
      values ('${ORG_A}', '${leadB}', 'ancora do vizinho', 100);
    `);
    expect(negocio).toContain("cobranca_lead_org_mismatch");

    const conversa = sqlEsperandoErro(`
      insert into public.cobrancas_avulsas
        (organization_id, conversation_id, descricao, valor_cents)
      values ('${ORG_A}', '${conversaB}', 'conversa do vizinho', 100);
    `);
    expect(conversa).toContain("cobranca_conversa_org_mismatch");

    const contato = sqlEsperandoErro(`
      insert into public.cobrancas_avulsas
        (organization_id, lead_id, contact_id, descricao, valor_cents)
      values ('${ORG_A}', '${leadA}', '${contatoB}', 'contato do vizinho', 100);
    `);
    expect(contato).toContain("cobranca_contato_org_mismatch");
  });

  it("cobrança sem negócio E sem conversa não existe (constraint de âncora)", () => {
    const erro = sqlEsperandoErro(`
      insert into public.cobrancas_avulsas
        (organization_id, descricao, valor_cents)
      values ('${ORG_A}', 'valor no vacuo', 100);
    `);
    expect(erro).toContain("cobrancas_avulsas_tem_ancora");
  });

  it("a sessão NÃO confirma pagamento — nem no insert, nem no update", () => {
    const noInsert = comoUsuarioEsperandoErro(
      USER_A,
      `insert into public.cobrancas_avulsas
         (organization_id, lead_id, descricao, valor_cents, estado, pago_em)
       values ('${ORG_A}', '${leadA}', 'ja paga', 100, 'paga', now());`,
    );
    expect(noInsert).toContain("cobranca_nasce_pendente");

    const noUpdate = comoUsuarioEsperandoErro(
      USER_A,
      `update public.cobrancas_avulsas set estado = 'paga', pago_em = now()
        where organization_id = '${ORG_A}';`,
    );
    expect(noUpdate).toContain("cobranca_paga_e_do_servidor");

    expect(
      ultimoNumero(
        sql(`select count(*) from public.cobrancas_avulsas where organization_id = '${ORG_A}' and estado = 'paga';`),
      ),
    ).toBe(0);
  });

  it("a sessão CANCELA, e cancelar é o único desfecho que ela alcança", () => {
    comoUsuario(
      USER_A,
      `update public.cobrancas_avulsas
          set estado = 'cancelada', cancelada_em = now()
        where organization_id = '${ORG_A}' and estado = 'pendente';`,
    );
    expect(
      comoUsuario(
        USER_A,
        `select estado from public.cobrancas_avulsas where organization_id = '${ORG_A}';`,
      ),
    ).toMatch(/cancelada/);

    // Cancelada sai do alcance do UPDATE (USING exige pendente): reabrir pela
    // sessão não muda linha nenhuma — e o valor não pode ser "corrigido" por
    // quem cancela, que é o que o gatilho também confere.
    comoUsuario(
      USER_A,
      `update public.cobrancas_avulsas set estado = 'pendente'
        where organization_id = '${ORG_A}';`,
    );
    expect(
      ultimoNumero(
        sql(`select count(*) from public.cobrancas_avulsas
              where organization_id = '${ORG_A}' and estado = 'cancelada';`),
      ),
    ).toBe(1);
  });

  it("o SERVIDOR confirma o pagamento (controle positivo da cerca 4)", () => {
    sql(`
      insert into public.cobrancas_avulsas
        (organization_id, lead_id, descricao, valor_cents, vencimento)
      values ('${ORG_A}', '${leadA}', 'Mensalidade', 9900, '2026-11-01');
    `);
    // `postgres` é o papel do jobs/webhook quando roda com service_role: a
    // cerca é a SESSÃO que confirma, e a derivação de "vencida" é do app.
    sql(`
      update public.cobrancas_avulsas
         set estado = 'paga', pago_em = now()
       where organization_id = '${ORG_A}' and descricao = 'Mensalidade';
    `);
    expect(
      ultimoNumero(
        sql(`select count(*) from public.cobrancas_avulsas
              where organization_id = '${ORG_A}' and estado = 'paga' and pago_em is not null;`),
      ),
    ).toBe(1);
  });

  it("apagar exige MANAGER: o agent não apaga nem o que está pendente", () => {
    comoUsuario(
      USER_B,
      `insert into public.cobrancas_avulsas
         (organization_id, conversation_id, descricao, valor_cents)
       values ('${ORG_B}', '${conversaB}', 'a apagar', 200);`,
    );
    const saida = comoUsuario(
      USER_B,
      `with apagadas as (
         delete from public.cobrancas_avulsas
          where organization_id = '${ORG_B}' and descricao = 'a apagar'
        returning id)
       select count(*) from apagadas;`,
    );
    expect(ultimoNumero(saida)).toBe(0);
    expect(
      ultimoNumero(
        sql(`select count(*) from public.cobrancas_avulsas
              where organization_id = '${ORG_B}' and descricao = 'a apagar';`),
      ),
    ).toBe(1);
  });
});
