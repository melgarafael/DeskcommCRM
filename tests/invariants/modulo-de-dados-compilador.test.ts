import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { nomeDaTabela } from "@/lib/modulos/dados/nome";

// O compilador da onda 1 da ADR-0005: um módulo de TERCEIRO declara objetos e campos, e quem
// escreve o SQL é o banco, lendo o artefato JÁ ADMITIDO (imutável, validado, auditado). Nenhum SQL
// vem de quem chama — o parâmetro é o id de uma linha de `extension_artifacts`, não DDL. É o que
// mantém de pé o argumento D4 da ADR-0002 (provisionadora de efeito fixo, não escolhido pelo
// chamador) enquanto abre o marco 4 que a D9 deixou aberto.
if (!process.env.TEST_DB_PORT) throw new Error("TEST_DB_PORT ausente — execute pnpm test:db");
const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 4,
});
const query = (text: string, values: unknown[] = []) => pool.query(text, values);
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

const orgA = "d1a50000-0000-4000-8000-000000000001";
const orgB = "d1a50000-0000-4000-8000-000000000002";
const dono = "d1a50000-0000-4000-8000-000000000003";

/** Um manifesto `data` mínimo: um objeto, campos de tipos distintos, uma referência ao contato. */
function manifesto(overrides: Record<string, unknown> = {}) {
  const base = {
    format_version: 1,
    profile: "data",
    publisher: "clinica",
    name: "odontograma",
    version: "1.0.0",
    license: "MIT",
    host_api: { min: 1, max: 1 },
    permissions: ["dados.proprios"],
    dependencies: [],
    display: { title: { "pt-BR": "Odontograma" }, summary: { "pt-BR": "Dente a dente" }, category: "productivity", icon: "ListChecks" },
    configuration: {},
    contributions: {},
    data: {
      mode: "declarado",
      objetos: [
        {
          slug: "marcacao",
          rotulo: { "pt-BR": "Marcação" },
          campos: [
            { slug: "dente", tipo: "inteiro", obrigatorio: true },
            { slug: "condicao", tipo: "texto", obrigatorio: true },
            { slug: "valor", tipo: "dinheiro" },
            { slug: "feito_em", tipo: "data" },
          ],
          refs: [{ slug: "paciente", entidade: "contato", obrigatorio: true, ao_apagar: "cascata" }],
        },
      ],
    },
  };
  return { ...base, ...overrides };
}

/** Grava o artefato como se a admissão já o tivesse publicado. O caminho de admissão tem provas próprias. */
async function artefato(m: Record<string, unknown> = manifesto()) {
  const doc = JSON.stringify(m);
  const r = await query(
    `insert into public.extension_artifacts(sha256, byte_length, manifest, document)
     values ($1, $2, $3::jsonb, $3) returning id`,
    [hash(m), Buffer.byteLength(doc), doc],
  );
  return r.rows[0].id as string;
}

const compilar = async (artifactId: string) => {
  const r = await query("select public.fn_modulo_dados_compilar($1) resultado", [artifactId]);
  return r.rows[0].resultado;
};

/** `relname` da tabela que o compilador deve ter criado para o objeto dado. */
const tabela = "m_clinica_odontograma_marcacao";

async function limpar() {
  await query("delete from public.extension_operations where actor_id = $1", [dono]);
  await query("delete from public.extension_installations where publisher = 'clinica'");
  await query("delete from public.extension_catalogs where origin like 'https://dados%.invariant.test'");
  await query(`do $$ declare t record; begin
    for t in select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'm\\_clinica\\_%'
    loop execute format('drop table if exists public.%I cascade', t.relname); end loop; end $$;`);
  await query("delete from public.extension_artifacts where manifest->>'publisher' = 'clinica'");
}

/** Chama uma RPC `fn_extensions_*` como `service_role`, que é quem tem o grant. */
async function rpc(nome: string, args: unknown[]) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role service_role");
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: dono, role: "service_role" }),
    ]);
    const r = await c.query(
      `select public.fn_extensions_${nome}(${args.map((_, i) => `$${i + 1}`).join(",")}) resultado`,
      args,
    );
    await c.query("commit");
    return r.rows[0].resultado;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

/** A entrada do catálogo que corresponde a um manifesto: o catálogo anuncia, o pacote confirma. */
function entrada(m: Record<string, unknown>) {
  const doc = JSON.stringify(m);
  return {
    publisher: m.publisher,
    name: m.name,
    version: m.version,
    license: m.license,
    host_api: m.host_api,
    display: m.display,
    permissions: m.permissions,
    sha256: hash(m),
    byte_length: Buffer.byteLength(doc),
  };
}

beforeAll(async () => {
  await query("insert into auth.users(id, email) values ($1, $2) on conflict(id) do nothing", [
    dono,
    `${dono}@invariant.test`,
  ]);
  await query(
    `insert into platform_admins(user_id, granted_by, scope, mfa_required, reason)
     values ($1, $1, 'full', false, 'Teste de módulo de dados')
     on conflict(user_id) do update set revoked_at = null, scope = 'full'`,
    [dono],
  );
  for (const [id, slug] of [[orgA, "modulo-dados-a"], [orgB, "modulo-dados-b"]]) {
    await query(
      `insert into organizations(id, slug, legal_name, display_name)
       values ($1, $2, 'Módulo de dados', 'Módulo de dados') on conflict(id) do nothing`,
      [id, slug],
    );
  }
});
beforeEach(limpar);
afterAll(async () => {
  await limpar();
  await pool.end();
});

describe("módulo de dados: o banco compila o que o artefato declara", () => {
  it("cria a tabela do objeto com o nome prefixado, isolada por organização e fechada ao navegador", async () => {
    await compilar(await artefato());

    const existe = (await query("select to_regclass($1) reg", [`public.${tabela}`])).rows[0].reg;
    expect(existe).toBe(tabela);

    // Tabela de organização: a coluna existe, é obrigatória e aponta para organizations.
    const org = (await query(
      `select a.attnotnull, exists(
         select 1 from pg_constraint k where k.conrelid = a.attrelid and k.contype = 'f'
           and a.attnum = any(k.conkey) and k.confrelid = 'public.organizations'::regclass
       ) tem_fk
       from pg_attribute a where a.attrelid = $1::regclass and a.attname = 'organization_id'`,
      [`public.${tabela}`],
    )).rows[0];
    expect(org).toMatchObject({ attnotnull: true, tem_fk: true });

    // RLS ligada e nenhum GRANT para os papéis do navegador: toda mutação passa pela rota auditada.
    const rls = (await query("select relrowsecurity from pg_class where oid = $1::regclass", [`public.${tabela}`])).rows[0];
    expect(rls.relrowsecurity).toBe(true);

    const grants = await query(
      `select grantee, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = $1 and grantee in ('anon', 'authenticated')`,
      [tabela],
    );
    expect(grants.rows).toEqual([]);
  });

  it("cada campo declarado vira coluna com o tipo do vocabulário, e `obrigatorio` vira not null", async () => {
    await compilar(await artefato());

    const colunas = await query(
      `select a.attname, format_type(a.atttypid, a.atttypmod) tipo, a.attnotnull
         from pg_attribute a
        where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
        order by a.attnum`,
      [`public.${tabela}`],
    );
    const porNome = Object.fromEntries(colunas.rows.map((c) => [c.attname, c]));

    expect(porNome.dente).toMatchObject({ tipo: "integer", attnotnull: true });
    expect(porNome.condicao).toMatchObject({ tipo: "text", attnotnull: true });
    expect(porNome.feito_em).toMatchObject({ tipo: "date", attnotnull: false });

    // Dinheiro segue a régua do projeto: inteiro de centavos + moeda ISO-4217, nunca `numeric` solto.
    expect(porNome.valor_cents).toMatchObject({ tipo: "bigint", attnotnull: false });
    expect(porNome.valor_moeda).toMatchObject({ tipo: "text" });

    // E o campo não declarado não aparece: o vocabulário é fechado, não um passe livre.
    expect(porNome.laudo).toBeUndefined();
  });

  it("a referência ao contato é COMPOSTA por organização: contato de outro tenant é recusado", async () => {
    // Por que composta: a checagem de chave estrangeira NÃO passa por RLS. Uma FK simples para
    // `contacts(id)` aceitaria o id de um contato de outra organização, e o módulo viraria uma ponte
    // entre tenants — vazamento sem nenhuma consulta maliciosa, só apontando para o id certo.
    await compilar(await artefato());

    const contatoA = (await query(
      "insert into public.contacts(organization_id, name) values ($1, 'Paciente A') returning id",
      [orgA],
    )).rows[0].id;

    // Mesma organização: passa.
    await query(
      `insert into public.${tabela}(organization_id, paciente_id, dente, condicao) values ($1, $2, 11, 'higido')`,
      [orgA, contatoA],
    );

    // Organização diferente, apontando para o contato da primeira: a chave composta recusa.
    await expect(
      query(
        `insert into public.${tabela}(organization_id, paciente_id, dente, condicao) values ($1, $2, 11, 'higido')`,
        [orgB, contatoA],
      ),
    ).rejects.toThrow(/violates foreign key constraint/);
  });
});

describe("módulo de dados: instala pelo caminho das extensões, que já tem recibo e tela", () => {
  // A porta ao usuário NÃO é uma rota nova: é a de extensões, que já traz catálogo admitido,
  // download com guarda de SSRF, autoridade de administrador da instalação, recibo idempotente,
  // precondição por revisão e tela em /admin/extensoes. O que a onda 1 acrescenta é o efeito: ao
  // concluir a instalação de um pacote `data`, as tabelas declaradas nascem na mesma transação.
  it("concluir a instalação de um pacote `data` cria as tabelas na MESMA transação do recibo", async () => {
    const m = manifesto();
    const e = entrada(m);
    const snapshot = { format_version: 1, origin: "https://dados.invariant.test", revision: 1, entries: [e] };
    const catalogo = (await rpc("admit_catalog", [dono, randomUUID(), JSON.stringify(snapshot), hash(snapshot)]))
      .catalog_id as string;

    const preparo = await rpc("prepare_install", [
      dono, randomUUID(), catalogo, e.publisher, e.name, e.version, null,
    ]);

    const recibo = await rpc("finish_install", [
      dono, preparo.id, JSON.stringify(m), e.sha256, e.byte_length, JSON.stringify(m),
    ]);

    expect(recibo.status).toBe("completed");

    // O efeito do perfil `data`: a tabela do objeto declarado existe.
    const reg = (await query("select to_regclass($1) reg", [`public.${tabela}`])).rows[0].reg;
    expect(reg).toBe(tabela);

    // E continua sendo uma instalação de extensão como qualquer outra: ponteiro gravado.
    const instalacao = (await query(
      "select artifact_id from extension_installations where publisher = $1 and name = $2",
      [e.publisher, e.name],
    )).rows[0];
    expect(instalacao.artifact_id).toBeTruthy();
  });
});

describe("módulo de dados: mesclar contatos não deixa a ficha presa no contato morto", () => {
  // Juntar duas fichas de contato NÃO apaga a perdedora: ela fica com `is_merged_into` apontando
  // para a vencedora, e `fn_mesclar_contatos` REPONTA quem a referenciava. O laço dela varre
  // `pg_constraint` buscando FK para `contacts` — mas só as de UMA coluna (`array_length(conkey,1)=1`,
  // usando `conkey[1]`). A FK de um módulo é COMPOSTA por organização, então ficava de fora: a ficha
  // do módulo continuava apontando para o contato morto, e quem procurasse pela pessoa viva não a
  // encontrava. Não é perda de linha, é pior — é dado que existe e não aparece.
  it("a ficha do módulo passa a apontar para o contato que ficou", async () => {
    await compilar(await artefato());

    const principal = (await query(
      "insert into public.contacts(organization_id, name) values ($1, 'Quem fica') returning id",
      [orgA],
    )).rows[0].id;
    const secundario = (await query(
      "insert into public.contacts(organization_id, name) values ($1, 'Quem sai') returning id",
      [orgA],
    )).rows[0].id;

    const ficha = (await query(
      `insert into public.${tabela}(organization_id, paciente_id, dente, condicao)
       values ($1, $2, 21, 'restaurado') returning id`,
      [orgA, secundario],
    )).rows[0].id;

    // O CONTROLE, na MESMA fusão: uma tabela do núcleo que referencia contato por FK de UMA coluna
    // tem de continuar repontada. A primeira tentativa deste conserto usava subquery escalar dentro
    // do `ON` e zerava o laço INTEIRO — nada era repontado, nem o que já funcionava, e em silêncio.
    // Sem este controle, aquele defeito passaria como verde.
    const marca = (await query(
      `insert into public.meta_ads_click_refs(organization_id, contact_id, token, utm)
       values ($1, $2, $3, '{"utm_source":"teste"}'::jsonb) returning id`,
      [orgA, secundario, `tok-${secundario}`],
    )).rows[0].id;

    await query("select public.fn_mesclar_contatos($1, $2, $3::uuid[])", [orgA, principal, [secundario]]);

    const nucleo = (await query("select contact_id from public.meta_ads_click_refs where id = $1", [
      marca,
    ])).rows[0];
    expect(nucleo.contact_id).toBe(principal);

    const depois = (await query(`select paciente_id from public.${tabela} where id = $1`, [ficha]))
      .rows[0];
    expect(depois.paciente_id).toBe(principal);
  });
});

describe("módulo de dados: o TypeScript e o SQL calculam o MESMO nome de tabela", () => {
  // A regra de nome vive em dois lugares por necessidade: o compilador monta o DDL dentro do banco, e
  // o resolvedor do serviço precisa saber ONDE ler. Duas implementações da mesma regra é dívida — e a
  // forma de pagá-la é esta: comparar o nome que o TypeScript calcula com a tabela que o banco CRIOU
  // de verdade. Mudar a regra de um lado só reprova aqui, em vez de virar 404 em produção.
  it("o nome que o resolvedor calcula é a tabela que o compilador criou", async () => {
    const criadas = (await compilar(await artefato())).tabelas as string[];
    const m = manifesto() as unknown as {
      publisher: string;
      name: string;
      data: { objetos: { slug: string }[] };
    };
    const esperado = m.data.objetos.map((o) => nomeDaTabela(m.publisher, m.name, o.slug));

    expect(criadas).toEqual(esperado);
    // E a tabela existe com esse nome — o controle contra os dois lados estarem igualmente errados.
    for (const nome of esperado) {
      const reg = (await query("select to_regclass($1) reg", [`public.${nome}`])).rows[0].reg;
      expect(reg).toBe(nome);
    }
  });
});
