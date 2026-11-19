import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { countAs, sql, writeCountAs } from "./gov-helpers";

/**
 * AS IDENTIDADES DO CONTATO SÃO ÚNICAS, ISOLADAS POR ORGANIZAÇÃO, ESCREVÍVEIS
 * SÓ A PARTIR DE `agent`, SOMEM NA ANONIMIZAÇÃO E SEGUEM A FICHA NA FUSÃO
 * (issue #3764, fatia 1 — migration 9419).
 *
 * ## O que este arquivo prova, e por que cada um importa
 *
 * 1. **`unique (organization_id, canal, identificador)`** — o coração da fatia:
 *    o mesmo perfil não pode morar em DUAS fichas da mesma organização. É o
 *    índice que a ingestão das redes consulta para achar a ficha de quem
 *    escreveu; com duas donas, a resposta seria arbitrária.
 * 2. **A forma canônica é do BANCO, não só da biblioteca** — `fn_identificador_canonico`
 *    no gatilho e na constraint. `@Pessoa.A`, `pessoa.a` e a URL do perfil são
 *    a MESMA identidade; se o banco gravasse texto cru, o índice seria
 *    decorativo e o defeito seria mudo.
 * 3. **A identidade é do TENANT do contato** — uma linha com o
 *    `organization_id` de A apontando para o contato de B passaria pela RLS de A
 *    e entregaria a ficha do vizinho. Recusa com `23503`.
 * 4. **RLS** — leitura por organização (0 linhas cross-tenant, com controle
 *    positivo) e escrita a partir de `agent`: um `viewer` falando direto com o
 *    PostgREST não troca a identidade de uma ficha.
 * 5. **LGPD** — anonimizar apaga as identidades. Perfil social não tem versão
 *    anonimizada que ainda sirva; deixá-lo legível depois de um pedido de
 *    exclusão é o modo de falha silencioso que a cascata do repositório existe
 *    para impedir.
 * 6. **Fusão** — `fn_mesclar_contatos` reponta as identidades para a vencedora,
 *    e a DM nova de uma identidade da absorvida acha a ficha viva, mesmo quando
 *    a vencedora já tinha o seu `social_identity` (o caso que a herança de
 *    `social_identity` não cobre).
 * 7. **Carga inicial** — a seção 5 do bloco do baseline leva o
 *    `social_identity` das fichas que já existem para a tabela, e o da lápide
 *    de uma fusão antiga para a vencedora.
 *
 * Dados sintéticos (`@invariant.test`), nada de PII real.
 */

const ORG_A = "dddddddd-0000-4000-8000-000000000001";
const ORG_B = "dddddddd-0000-4000-8000-000000000002";
const AGENTE_A = "dddddddd-1111-4000-8000-000000000001";
const VIEWER_A = "dddddddd-1111-4000-8000-000000000002";
const AGENTE_B = "dddddddd-1111-4000-8000-000000000003";
const CONTATO_A = "dddddddd-3333-4000-8000-000000000001";
const CONTATO_A2 = "dddddddd-3333-4000-8000-000000000002";
const CONTATO_B = "dddddddd-3333-4000-8000-000000000003";
const CONTATO_ANON = "dddddddd-3333-4000-8000-000000000004";

/** O perfil do Instagram da pessoa de A, na forma canônica. */
const PERFIL_A = "pessoa.a";
/** O id do participante que a DM do Facebook entrega para a pessoa de A. */
const PSID_A = "1000000000000001";

/** Roda um SQL que DEVE falhar e devolve o stderr do psql. */
function falha(script: string): string {
  try {
    // `VERBOSITY verbose` põe o SQLSTATE na mensagem: o teste passa a cobrar o
    // CÓDIGO (23505/23503/23502), não o texto de uma tradução qualquer.
    sql(`\\set VERBOSITY verbose\n${script}`);
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? "");
  }
  throw new Error("esperava falha do banco e o comando passou");
}

beforeAll(() => {
  sql(`
    do $seed$
    begin
      insert into auth.users (id, email) values
        ('${AGENTE_A}', 'ident-org-a-agent@invariant.test'),
        ('${VIEWER_A}', 'ident-org-a-viewer@invariant.test'),
        ('${AGENTE_B}', 'ident-org-b-agent@invariant.test')
        on conflict (id) do nothing;

      insert into public.organizations (id, slug, legal_name, display_name) values
        ('${ORG_A}', 'ident-inv-a', 'Identidades Invariant A', 'Identidades A'),
        ('${ORG_B}', 'ident-inv-b', 'Identidades Invariant B', 'Identidades B')
        on conflict (id) do nothing;

      insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
        ('${AGENTE_A}', '${ORG_A}', 'agent', now()),
        ('${VIEWER_A}', '${ORG_A}', 'viewer', now()),
        ('${AGENTE_B}', '${ORG_B}', 'agent', now())
        on conflict do nothing;

      insert into public.contacts (id, organization_id, display_name) values
        ('${CONTATO_A}', '${ORG_A}', 'Identidades Contato A'),
        ('${CONTATO_A2}', '${ORG_A}', 'Identidades Contato A2'),
        ('${CONTATO_B}', '${ORG_B}', 'Identidades Contato B'),
        ('${CONTATO_ANON}', '${ORG_A}', 'Identidades Contato Anon')
        on conflict (id) do nothing;

      -- A identidade base da pessoa de A, e a MESMA identidade na organização B:
      -- o unique é por organização, então as duas coexistem — e é isso que o
      -- caso 2 mede.
      insert into public.contact_identities (organization_id, contact_id, canal, identificador)
      values
        ('${ORG_A}', '${CONTATO_A}', 'instagram', '${PERFIL_A}'),
        ('${ORG_A}', '${CONTATO_A}', 'facebook', '${PSID_A}'),
        ('${ORG_B}', '${CONTATO_B}', 'instagram', '${PERFIL_A}')
      on conflict (organization_id, canal, identificador) do nothing;
    end
    $seed$;
  `);
});

describe("contact_identities — unicidade e forma canônica", () => {
  it("o mesmo par (organização, canal, identificador) não existe duas vezes", () => {
    // Outra FICHA da mesma organização com o perfil de A: é exatamente o
    // estado que a fatia existe para impedir.
    const stderr = falha(`
      insert into public.contact_identities (organization_id, contact_id, canal, identificador)
      values ('${ORG_A}', '${CONTATO_A2}', 'instagram', '${PERFIL_A}');
    `);
    expect(stderr).toContain("23505");
    expect(stderr).toContain("uniq_contact_identities_org_canal_identificador");
  });

  it("a MESMA identidade em outra organização é outra linha (unique é por tenant)", () => {
    expect(sql(`select count(*) from public.contact_identities
                 where organization_id = '${ORG_B}' and canal = 'instagram' and identificador = '${PERFIL_A}';`)).toBe("1");
    expect(sql(`select count(*) from public.contact_identities
                 where organization_id = '${ORG_A}' and canal = 'instagram' and identificador = '${PERFIL_A}';`)).toBe("1");
  });

  it("a URL do perfil, com maiúscula, cai na MESMA identidade", () => {
    // Sem a régua no banco, esta linha entraria e a pessoa teria duas fichas.
    const stderr = falha(`
      insert into public.contact_identities (organization_id, contact_id, canal, identificador)
      values ('${ORG_A}', '${CONTATO_A2}', 'instagram', 'https://www.instagram.com/Pessoa.A/');
    `);
    expect(stderr).toContain("23505");
  });

  it("o identificador é gravado na forma canônica do canal", () => {
    sql(`
      insert into public.contact_identities (organization_id, contact_id, canal, identificador)
      values
        ('${ORG_A}', '${CONTATO_A2}', 'instagram', '  @Pessoa.C '),
        ('${ORG_A}', '${CONTATO_A2}', 'facebook', 'https://www.facebook.com/Pessoa.B/?ref=page')
      on conflict (organization_id, canal, identificador) do nothing;
    `);
    expect(sql(`select string_agg(canal || '=' || identificador, ',' order by canal)
                  from public.contact_identities
                 where organization_id = '${ORG_A}' and contact_id = '${CONTATO_A2}';`)).toBe(
      "facebook=pessoa.b,instagram=pessoa.c",
    );
  });

  it("valor que não é identificador do canal não entra", () => {
    // Perfil com espaço e `@` no fim não viram identidade: identidade vazia
    // colidiria com a de outra ficha "sem identificador".
    expect(
      falha(`insert into public.contact_identities (organization_id, contact_id, canal, identificador)
             values ('${ORG_A}', '${CONTATO_A2}', 'instagram', 'com espaço');`),
    ).toContain("identidade_vazia");
    expect(
      falha(`insert into public.contact_identities (organization_id, contact_id, canal, identificador)
             values ('${ORG_A}', '${CONTATO_A2}', 'facebook', 'pessoa.b@');`),
    ).toContain("identidade_vazia");
    // Telefone e e-mail têm guarda própria e não entram aqui.
    expect(
      falha(`insert into public.contact_identities (organization_id, contact_id, canal, identificador)
             values ('${ORG_A}', '${CONTATO_A2}', 'whatsapp', '+5531977776666');`),
    ).toContain("identidade_vazia");
    // E o texto CRU nunca chega a ficar gravado: a constraint é a segunda cerca.
    expect(sql(`select public.fn_identificador_canonico('instagram', 'com espaço') is null;`)).toBe("t");
  });

  it("identidade de ficha de OUTRA organização é recusada", () => {
    // A RLS de A deixaria passar a linha pelo organization_id; o contato é de B.
    const stderr = falha(`
      insert into public.contact_identities (organization_id, contact_id, canal, identificador)
      values ('${ORG_A}', '${CONTATO_B}', 'instagram', 'vazando');
    `);
    expect(stderr).toContain("23503");
    expect(stderr).toContain("identidade_de_outra_organizacao");
  });
});

describe("contact_identities — RLS por organização e papel", () => {
  it("RLS está ligada na tabela", () => {
    expect(
      sql(`select relrowsecurity from pg_class where oid = 'public.contact_identities'::regclass;`),
    ).toBe("t");
  });

  it("a organização A lê as identidades dela e ZERO da B", () => {
    expect(
      countAs(AGENTE_A, `select count(*) from public.contact_identities where organization_id = '${ORG_B}';`),
    ).toBe(0);
    // Controle positivo: as linhas de A continuam legíveis.
    expect(
      countAs(AGENTE_A, `select count(*) from public.contact_identities where organization_id = '${ORG_A}';`),
    ).toBeGreaterThanOrEqual(2);
  });

  it("`viewer` não escreve identidade; `agent` escreve", () => {
    const novoDoViewer = `insert into public.contact_identities (organization_id, contact_id, canal, identificador)
      values ('${ORG_A}', '${CONTATO_A}', 'facebook', 'viewer-nao-escreve')`;
    expect(writeCountAs(VIEWER_A, novoDoViewer)).toBe(0);

    const novoDoAgente = `insert into public.contact_identities (organization_id, contact_id, canal, identificador)
      values ('${ORG_A}', '${CONTATO_A}', 'facebook', 'agent-escreve')
      on conflict (organization_id, canal, identificador) do nothing`;
    expect(writeCountAs(AGENTE_A, novoDoAgente)).toBe(1);
  });
});

describe("contact_identities — LGPD", () => {
  it("anonimizar a ficha apaga as identidades dela", () => {
    sql(`
      insert into public.contact_identities (organization_id, contact_id, canal, identificador)
      values
        ('${ORG_A}', '${CONTATO_ANON}', 'instagram', 'apagar.anon'),
        ('${ORG_A}', '${CONTATO_ANON}', 'facebook', '1000000000000099')
      on conflict (organization_id, canal, identificador) do nothing;
    `);
    expect(
      sql(`select count(*) from public.contact_identities where contact_id = '${CONTATO_ANON}';`),
    ).toBe("2");

    sql(`update public.contacts set is_anonymized = true, anonymized_at = now()
          where id = '${CONTATO_ANON}' and organization_id = '${ORG_A}';`);

    expect(
      sql(`select count(*) from public.contact_identities where contact_id = '${CONTATO_ANON}';`),
    ).toBe("0");
    // E o perfil dela não pode voltar enquanto a ficha está anonimizada:
    // o gatilho recusa gravar identidade em ficha anonimizada.
    expect(
      falha(`insert into public.contact_identities (organization_id, contact_id, canal, identificador)
             values ('${ORG_A}', '${CONTATO_ANON}', 'instagram', 'apagar.anon');`),
    ).toContain("identidade_de_ficha_indisponivel");
  });
});

/**
 * A JUNÇÃO MANUAL, medida onde ela acontece de verdade: `fn_mesclar_contatos`.
 *
 * Quem MOVE os ponteiros é a função de banco — e é ela que decide o que acontece com
 * conversas, mensagens, negócios e identidades da ficha absorvida. Ela reponta
 * toda FK para `contacts` pelo CATÁLOGO (`pg_constraint`), nunca por lista à
 * mão; este bloco existe para que "o catálogo pega a tabela nova" seja medido, e
 * não suposto. Sem ele, o `unique (organization_id, canal, identificador)`
 * poderia transformar a fusão num erro cru de banco (23505) na primeira vez que
 * duas fichas com a mesma pessoa fossem juntadas — e o defeito só apareceria em
 * produção, na mão do mantenedor.
 */
describe("contact_identities — a junção manual move as identidades", () => {
  const FICA = "dddddddd-3333-4000-8000-0000000000f1";
  const ABSORVIDA = "dddddddd-3333-4000-8000-0000000000f2";

  it("a identidade da ficha absorvida vai para a principal e nenhuma sobra na lápide", () => {
    sql(`
      insert into public.contacts (id, organization_id, display_name) values
        ('${FICA}', '${ORG_A}', 'Identidades Fica'),
        ('${ABSORVIDA}', '${ORG_A}', 'Identidades Absorvida')
        on conflict (id) do nothing;

      insert into public.contact_identities (organization_id, contact_id, canal, identificador)
      values
        ('${ORG_A}', '${FICA}', 'instagram', 'junta.fica'),
        ('${ORG_A}', '${FICA}', 'facebook', '1000000000000101'),
        ('${ORG_A}', '${ABSORVIDA}', 'instagram', '17841400000000102'),
        ('${ORG_A}', '${ABSORVIDA}', 'facebook', '1000000000000102'),
        ('${ORG_A}', '${ABSORVIDA}', 'instagram', '@junta.absorvida')
      on conflict (organization_id, canal, identificador) do nothing;
    `);
    expect(
      sql(`select count(*) from public.contact_identities where contact_id = '${ABSORVIDA}';`),
    ).toBe("3");

    // Uma chamada só: a fusão não é idempotente (a segunda acha o secundário
    // indisponível), então o que interessa vem na mesma linha.
    const saida = sql(`
      with m as (
        select public.fn_mesclar_contatos(
          '${ORG_A}', '${FICA}', array['${ABSORVIDA}']::uuid[]
        ) as r
      )
      select coalesce(r->'repontado'->>'contact_identities.contact_id', '-')
             || '|'
             || coalesce(r->'nao_repontado'->>'contact_identities.contact_id', '-')
        from m;
    `).split("\n").pop();

    // Repontou as três, e nenhuma ficou para trás (`nao_repontado` é o que a
    // tela anuncia como "continuou no cadastro antigo").
    expect(saida).toBe("3|-");

    expect(
      sql(`select count(*) from public.contact_identities where contact_id = '${ABSORVIDA}';`),
    ).toBe("0");
    expect(
      sql(`select count(*) from public.contact_identities where contact_id = '${FICA}';`),
    ).toBe("5");

    // A lápide não aceita identidade nova: quem for vincular a pessoa de novo
    // tem de achar a ficha viva, senão a duplicata renasce por baixo da fusão.
    expect(
      falha(`insert into public.contact_identities (organization_id, contact_id, canal, identificador)
             values ('${ORG_A}', '${ABSORVIDA}', 'facebook', 'junta.absorvida');`),
    ).toContain("identidade_de_ficha_indisponivel");

    // E o par movido continua ÚNICO na organização: tentar dá-lo a uma terceira
    // ficha é 23505, não uma segunda linha.
    expect(
      falha(`insert into public.contact_identities (organization_id, contact_id, canal, identificador)
             values ('${ORG_A}', '${CONTATO_A}', 'instagram', 'junta.absorvida');`),
    ).toContain("23505");
  });

  /**
   * O caso que a herança de `social_identity` não cobre. `fn_mesclar_contatos`
   * só passa o `social_identity` da absorvida para a vencedora quando a
   * vencedora não tem o seu (`coalesce`); com o Instagram numa ficha e o
   * Facebook na outra, o da absorvida ficava na lápide, e a busca da ingestão
   * por `social_identity` (`upsertSocialContact`, que ignora ficha mesclada)
   * não achava ninguém vivo — a próxima conversa criava uma ficha nova.
   *
   * As duas consultas abaixo são as que `upsertSocialContact` faz, na ordem:
   * primeiro a identidade, depois o `social_identity`.
   */
  it("a DM nova da identidade absorvida acha a vencedora, mesmo quando ela já tinha o seu social_identity", () => {
    const VENCEDORA = "dddddddd-3333-4000-8000-0000000000f3";
    const PERDEDORA = "dddddddd-3333-4000-8000-0000000000f4";
    const SOCIAL_VENCEDORA = "instagram:conta-inv-1:17841400000000301";
    const SOCIAL_PERDEDORA = "facebook:conta-inv-2:1000000000000302";
    sql(`
      insert into public.contacts (id, organization_id, display_name, social_identity) values
        ('${VENCEDORA}', '${ORG_A}', 'Identidades Vencedora', '${SOCIAL_VENCEDORA}'),
        ('${PERDEDORA}', '${ORG_A}', 'Identidades Perdedora', '${SOCIAL_PERDEDORA}')
        on conflict (id) do nothing;

      insert into public.contact_identities (organization_id, contact_id, canal, identificador)
      values
        ('${ORG_A}', '${VENCEDORA}', 'instagram', '17841400000000301'),
        ('${ORG_A}', '${PERDEDORA}', 'facebook', '1000000000000302')
      on conflict (organization_id, canal, identificador) do nothing;

      select public.fn_mesclar_contatos('${ORG_A}', '${VENCEDORA}', array['${PERDEDORA}']::uuid[]);
    `);

    // A busca antiga, sozinha: ninguém vivo — é aqui que a duplicata renascia.
    expect(
      sql(`select count(*) from public.contacts
            where organization_id = '${ORG_A}' and social_identity = '${SOCIAL_PERDEDORA}'
              and is_merged_into is null;`),
    ).toBe("0");

    // A busca pela identidade: a vencedora.
    expect(
      sql(`select ci.contact_id from public.contact_identities ci
             join public.contacts c on c.id = ci.contact_id and c.is_merged_into is null
            where ci.organization_id = '${ORG_A}' and ci.canal = 'facebook'
              and ci.identificador = '1000000000000302';`),
    ).toBe(VENCEDORA);
  });
});

/**
 * A CARGA INICIAL, medida com o SQL que o self-hoster aplica: a seção 5 do
 * bloco desta migration no `supabase/baseline.sql`, recortada e rodada de novo
 * depois de semear fichas — no banco do teste ela já rodou, mas com
 * `contacts` vazia.
 */
describe("contact_identities — a carga inicial a partir de social_identity", () => {
  const VIVA = "dddddddd-3333-4000-8000-0000000000c1";
  const VENCEDORA = "dddddddd-3333-4000-8000-0000000000c2";
  const LAPIDE = "dddddddd-3333-4000-8000-0000000000c3";
  const LAPIDE_ANONIMIZADA = "dddddddd-3333-4000-8000-0000000000c4";
  const OUTRA_REDE = "dddddddd-3333-4000-8000-0000000000c5";

  function cargaInicial(): string {
    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    const inicio = baseline.indexOf("-- ── 5. As fichas que já existem");
    expect(inicio, "a seção 5 sumiu do bloco do baseline").toBeGreaterThan(-1);
    const fim = baseline.indexOf("do nothing;", inicio);
    expect(fim).toBeGreaterThan(inicio);
    return baseline.slice(inicio, fim + "do nothing;".length);
  }

  function donoDe(canal: string, identificador: string): string {
    return sql(`select coalesce(string_agg(contact_id::text, ','), '-') from public.contact_identities
                 where organization_id = '${ORG_A}' and canal = '${canal}'
                   and identificador = '${identificador}';`);
  }

  it("a ficha viva leva a sua; a lápide entrega a dela à vencedora; anonimizada e outra rede ficam fora", () => {
    sql(`
      insert into public.contacts (id, organization_id, display_name, social_identity) values
        ('${VIVA}', '${ORG_A}', 'Carga Viva', 'instagram:conta-c:17841400000000401'),
        ('${VENCEDORA}', '${ORG_A}', 'Carga Vencedora', 'instagram:conta-c:17841400000000402'),
        ('${OUTRA_REDE}', '${ORG_A}', 'Carga Outra Rede', 'linkedin:conta-e:405')
        on conflict (id) do nothing;
      insert into public.contacts (id, organization_id, display_name, social_identity, is_merged_into) values
        ('${LAPIDE}', '${ORG_A}', 'Carga Lápide', 'facebook:conta-d:1000000000000403', '${VENCEDORA}')
        on conflict (id) do nothing;
      insert into public.contacts
        (id, organization_id, display_name, social_identity, is_merged_into, is_anonymized, anonymized_at) values
        ('${LAPIDE_ANONIMIZADA}', '${ORG_A}', 'Carga Anon', 'facebook:conta-d:1000000000000404',
         '${VENCEDORA}', true, now())
        on conflict (id) do nothing;
    `);

    sql(cargaInicial());

    expect(donoDe("instagram", "17841400000000401")).toBe(VIVA);
    expect(donoDe("instagram", "17841400000000402")).toBe(VENCEDORA);
    expect(donoDe("facebook", "1000000000000403")).toBe(VENCEDORA);
    expect(donoDe("facebook", "1000000000000404")).toBe("-");
    expect(
      sql(`select count(*) from public.contact_identities where contact_id = '${OUTRA_REDE}';`),
    ).toBe("0");

    // Rodar de novo é o `update.sh`: nada duplica e nada falha.
    sql(cargaInicial());
    expect(
      sql(`select count(*) from public.contact_identities
            where contact_id in ('${VIVA}', '${VENCEDORA}');`),
    ).toBe("3");
  });
});
