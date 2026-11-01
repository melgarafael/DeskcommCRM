import { beforeAll, describe, expect, it } from "vitest";

import { countAs, sql, writeCountAs } from "./gov-helpers";

/**
 * AS IDENTIDADES DO CONTATO SÃO ÚNICAS, ISOLADAS POR ORGANIZAÇÃO, ESCREVÍVEIS
 * SÓ A PARTIR DE `agent` E SOMEM NA ANONIMIZAÇÃO (issue #3764, fatia 1 —
 * migration 9082).
 *
 * ## O que este arquivo prova, e por que cada um importa
 *
 * 1. **`unique (organization_id, canal, identificador)`** — o coração da fatia:
 *    o mesmo e-mail, número ou perfil não pode morar em DUAS fichas da mesma
 *    organização. Sem ele, "vincular as identidades a uma ficha única" seria
 *    convenção de código, e a primeira importação em massa criaria a segunda.
 * 2. **A forma canônica é do BANCO, não só da biblioteca** — `fn_identificador_canonico`
 *    no gatilho e na constraint. `+55 31 98888-7777`, `+5531988887777` e a
 *    grafia sem o nono dígito são a MESMA identidade; se o banco gravasse texto
 *    cru, o índice seria decorativo e o defeito seria mudo.
 * 3. **A identidade é do TENANT do contato** — uma linha com o
 *    `organization_id` de A apontando para o contato de B passaria pela RLS de A
 *    e entregaria a ficha do vizinho. Recusa com `23503`.
 * 4. **RLS** — leitura por organização (0 linhas cross-tenant, com controle
 *    positivo) e escrita a partir de `agent`: um `viewer` falando direto com o
 *    PostgREST não troca o e-mail de uma ficha.
 * 5. **LGPD** — anonimizar apaga as identidades. Telefone, e-mail e perfil
 *    social não têm versão anonimizada que ainda sirva; deixá-los legíveis
 *    depois de um pedido de exclusão é o modo de falha silencioso que a cascata
 *    do repositório existe para impedir.
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

/** O telefone da pessoa de A, na forma canônica (13 dígitos, com o nono). */
const TELEFONE_A = "+5531977776666";
/** A mesma pessoa com 12 dígitos — o `wa_id` que a WABA às vezes entrega. */
const TELEFONE_A_SEM_O_NONO = "+553177776666";
const EMAIL_A = "pessoa-a@invariant.test";

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
        ('${ORG_A}', '${CONTATO_A}', 'whatsapp', '${TELEFONE_A}'),
        ('${ORG_A}', '${CONTATO_A}', 'email', '${EMAIL_A}'),
        ('${ORG_B}', '${CONTATO_B}', 'email', '${EMAIL_A}')
      on conflict (organization_id, canal, identificador) do nothing;
    end
    $seed$;
  `);
});

describe("contact_identities — unicidade e forma canônica", () => {
  it("o mesmo par (organização, canal, identificador) não existe duas vezes", () => {
    // Outra FICHA da mesma organização com o telefone de A: é exatamente o
    // estado que a fatia existe para impedir.
    const stderr = falha(`
      insert into public.contact_identities (organization_id, contact_id, canal, identificador)
      values ('${ORG_A}', '${CONTATO_A2}', 'whatsapp', '${TELEFONE_A}');
    `);
    expect(stderr).toContain("23505");
    expect(stderr).toContain("uniq_contact_identities_org_canal_identificador");
  });

  it("a MESMA identidade em outra organização é outra linha (unique é por tenant)", () => {
    expect(sql(`select count(*) from public.contact_identities
                 where organization_id = '${ORG_B}' and canal = 'email' and identificador = '${EMAIL_A}';`)).toBe("1");
    expect(sql(`select count(*) from public.contact_identities
                 where organization_id = '${ORG_A}' and canal = 'email' and identificador = '${EMAIL_A}';`)).toBe("1");
  });

  it("a grafia sem o nono dígito cai na MESMA identidade", () => {
    // Sem a régua no banco, esta linha entraria e a pessoa teria duas fichas.
    const stderr = falha(`
      insert into public.contact_identities (organization_id, contact_id, canal, identificador)
      values ('${ORG_A}', '${CONTATO_A2}', 'whatsapp', '${TELEFONE_A_SEM_O_NONO}');
    `);
    expect(stderr).toContain("23505");
  });

  it("o identificador é gravado na forma canônica do canal", () => {
    sql(`
      insert into public.contact_identities (organization_id, contact_id, canal, identificador)
      values
        ('${ORG_A}', '${CONTATO_A2}', 'email', '  MAIUSCULA@INVARIANT.TEST '),
        ('${ORG_A}', '${CONTATO_A2}', 'instagram', '@Pessoa.A'),
        ('${ORG_A}', '${CONTATO_A2}', 'facebook', 'https://www.facebook.com/Pessoa.B/?ref=page')
      on conflict (organization_id, canal, identificador) do nothing;
    `);
    expect(sql(`select string_agg(canal || '=' || identificador, ',' order by canal)
                  from public.contact_identities
                 where organization_id = '${ORG_A}' and contact_id = '${CONTATO_A2}';`)).toBe(
      "email=maiuscula@invariant.test,facebook=pessoa.b,instagram=pessoa.a",
    );
  });

  it("valor que não é identificador do canal não entra", () => {
    // E-mail sem domínio e telefone sem dígito suficiente não viram identidade:
    // identidade vazia colidiria com a de outra ficha "sem identificador".
    expect(
      falha(`insert into public.contact_identities (organization_id, contact_id, canal, identificador)
             values ('${ORG_A}', '${CONTATO_A2}', 'email', 'sem-dominio');`),
    ).toContain("identidade_vazia");
    expect(
      falha(`insert into public.contact_identities (organization_id, contact_id, canal, identificador)
             values ('${ORG_A}', '${CONTATO_A2}', 'whatsapp', 'abc');`),
    ).toContain("identidade_vazia");
    // E o texto CRU nunca chega a ficar gravado: a constraint é a segunda cerca.
    expect(sql(`select public.fn_identificador_canonico('email', 'sem-dominio') is null;`)).toBe("t");
  });

  it("identidade de ficha de OUTRA organização é recusada", () => {
    // A RLS de A deixaria passar a linha pelo organization_id; o contato é de B.
    const stderr = falha(`
      insert into public.contact_identities (organization_id, contact_id, canal, identificador)
      values ('${ORG_A}', '${CONTATO_B}', 'email', 'vazando@invariant.test');
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
        ('${ORG_A}', '${CONTATO_ANON}', 'whatsapp', '+5531966665555'),
        ('${ORG_A}', '${CONTATO_ANON}', 'email', 'apagar@invariant.test')
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
    // E o telefone dela não pode ser reusado enquanto a ficha está anonimizada:
    // o gatilho recusa gravar identidade em ficha anonimizada.
    expect(
      falha(`insert into public.contact_identities (organization_id, contact_id, canal, identificador)
             values ('${ORG_A}', '${CONTATO_ANON}', 'whatsapp', '+5531966665555');`),
    ).toContain("identidade_de_ficha_indisponivel");
  });
});
