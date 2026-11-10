import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * Fidelidade do bootstrap legado, antes do baseline (Refs #887).
 *
 * Resgate do #3542, contribuição original de @webtecnica. As sondas próprias
 * do harness registram ACL direta e efetiva no schema de teste; só o recibo
 * atravessa o install/update e os moldes. Não exige ALL em tabelas finais.
 *
 * O perfil observado em imagens Supabase legadas não decide permissões de
 * projetos novos nem desfaz o fechamento do provedor (decisão219A).
 * PG15 tem sete privilégios de tabela; o ALL do PG17 inclui MAINTAIN.
 * A issue #887 já foi resolvida e lançada na 1.92; este é um reforço do harness.
 */
const PAPEIS = ["anon", "authenticated", "service_role"] as const;
const FAMILIAS = ["functions", "sequences", "tables"] as const;
const PERFIL = "supabase-public-legado-all";
const MARCA = "SONDA|";
const TABELA_PG15 = ["DELETE", "INSERT", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"];

interface LinhaDoRecibo {
  familia: string;
  papel: string;
  major: number;
  perfil: string;
  antes_do_baseline: boolean;
  sondas_removidas_antes_do_baseline: boolean;
  diretos: string[];
  efetivos: string[];
}

function sondas(corpo: string): string[] {
  return sql(corpo)
    .split("\n")
    .filter((linha) => linha.startsWith(MARCA))
    .map((linha) => linha.slice(MARCA.length));
}

function jsonDaSonda<T>(corpo: string): T {
  const linhas = sondas(corpo);
  if (linhas.length !== 1 || linhas[0] === undefined) {
    throw new Error("a sonda precisa devolver exatamente um resultado");
  }
  return JSON.parse(linhas[0]) as T;
}

function majorDoServidor(): number {
  return jsonDaSonda<number>(
    "select 'SONDA|' || (current_setting('server_version_num')::integer / 10000)::text;",
  );
}

const RECIBO_JSON =
  "coalesce((select jsonb_agg(to_jsonb(r) order by r.familia, r.papel) " +
  "from test_db.acl_do_bootstrap r), '[]'::jsonb)";

function lerRecibo(): unknown {
  return jsonDaSonda<unknown>("select 'SONDA|' || " + RECIBO_JSON + "::text;");
}

function privilegios(familia: string, major: number): string[] {
  if (familia === "functions") return ["EXECUTE"];
  if (familia === "sequences") return ["SELECT", "UPDATE", "USAGE"];
  return [...TABELA_PG15, ...(major === 17 ? ["MAINTAIN"] : [])].sort();
}

/** Falha fechada: ausência de metadados não vira um laço vazio aprovado. */
function conferirRecibo(valor: unknown, major: number): asserts valor is LinhaDoRecibo[] {
  if (major !== 15 && major !== 17) throw new Error("major sem perfil de bootstrap conferido");
  if (!Array.isArray(valor) || valor.length !== PAPEIS.length * FAMILIAS.length) {
    throw new Error("recibo precisa das nove combinações de família e papel");
  }
  const chaves = new Set<string>();
  for (const dado of valor) {
    if (dado === null || typeof dado !== "object") throw new Error("linha inválida do recibo");
    const linha = dado as Partial<LinhaDoRecibo>;
    if (
      typeof linha.familia !== "string" ||
      typeof linha.papel !== "string" ||
      !FAMILIAS.some((familia) => familia === linha.familia) ||
      !PAPEIS.some((papel) => papel === linha.papel)
    ) {
      throw new Error("família ou papel desconhecido no recibo");
    }
    if (
      linha.major !== major ||
      linha.perfil !== PERFIL ||
      linha.antes_do_baseline !== true ||
      linha.sondas_removidas_antes_do_baseline !== true
    ) {
      throw new Error("major, perfil ou instante do recibo não conferem");
    }
    const chave = linha.familia + "/" + linha.papel;
    if (chaves.has(chave)) throw new Error("combinação duplicada no recibo");
    chaves.add(chave);
    const esperado = privilegios(linha.familia, major);
    for (const origem of ["diretos", "efetivos"] as const) {
      const atual = linha[origem];
      if (
        !Array.isArray(atual) ||
        atual.some((item) => typeof item !== "string") ||
        JSON.stringify([...atual].sort()) !== JSON.stringify(esperado)
      ) {
        throw new Error(chave + ": privilégios " + origem + " fora do perfil da major");
      }
    }
  }
}

function aclsFinais(tabela: string, papel: string, lista: readonly string[]) {
  const literais = lista.map((privilegio) => "'" + privilegio + "'").join(",");
  return jsonDaSonda<{ diretos: string[]; efetivos: string[] }>(
    [
      "with t as (select 'public." + tabela + "'::regclass::oid as oid),",
      "p(privilegio) as (select unnest(array[" + literais + "]::text[]))",
      "select 'SONDA|' || jsonb_build_object(",
      "'diretos', array(select distinct a.privilege_type from pg_class c, aclexplode(c.relacl) a",
      "where c.oid=t.oid and a.grantee='" + papel + "'::regrole",
      "and a.privilege_type=any(array[" + literais + "]::text[]) order by a.privilege_type),",
      "'efetivos', array(select privilegio from p where",
      "has_table_privilege('" + papel + "', t.oid, privilegio) order by privilegio))::text from t;",
    ].join("\n"),
  );
}

describe("ACL do bootstrap anterior ao baseline, independente dos REVOKEs finais (#3542)", () => {
  it("o recibo e os três papéis existem de fato no catálogo", () => {
    const catalogo = jsonDaSonda<{ recibo: boolean; papeis: string[] }>(
      [
        "select 'SONDA|' || jsonb_build_object(",
        "'recibo', to_regclass('test_db.acl_do_bootstrap') is not null,",
        "'papeis', array(select rolname::text from pg_roles",
        "where rolname in ('anon','authenticated','service_role') order by rolname))::text;",
      ].join("\n"),
    );
    expect(catalogo.recibo).toBe(true);
    expect(catalogo.papeis).toEqual([...PAPEIS]);
  });

  it("o recibo tem major, perfil, instante e as nove ACLs completas", () => {
    expect(() => conferirRecibo(lerRecibo(), majorDoServidor())).not.toThrow();
  });

  it.each(FAMILIAS.flatMap((familia) => PAPEIS.map((papel) => ({ familia, papel }))))(
    "$familia / $papel: concessões diretas e efetivas vieram do bootstrap",
    ({ familia, papel }) => {
      const major = majorDoServidor();
      const recibo = lerRecibo();
      conferirRecibo(recibo, major);
      const linha = recibo.find((item) => item.familia === familia && item.papel === papel);
      expect(linha?.diretos).toEqual(privilegios(familia, major));
      expect(linha?.efetivos).toEqual(privilegios(familia, major));
    },
  );

  it.each(["vazio", "família", "linha", "major", "instante", "limpeza", "duplicado"] as const)(
    "o consumidor rejeita recibo sem a prova exigida: %s",
    (defeito) => {
      const major = majorDoServidor();
      const original = lerRecibo();
      conferirRecibo(original, major);
      let adulterado = structuredClone(original);
      if (defeito === "vazio") adulterado = [];
      if (defeito === "família")
        adulterado = adulterado.filter((linha) => linha.familia !== "functions");
      if (defeito === "linha") adulterado.pop();
      if (defeito === "major") delete (adulterado[0] as Partial<LinhaDoRecibo>).major;
      if (defeito === "instante") adulterado[0]!.antes_do_baseline = false;
      if (defeito === "limpeza") adulterado[0]!.sondas_removidas_antes_do_baseline = false;
      if (defeito === "duplicado") adulterado[0] = structuredClone(adulterado[1]!);
      expect(() => conferirRecibo(adulterado, major)).toThrow();
    },
  );

  it("as três sondas foram removidas antes de copiar os moldes", () => {
    const ausentes = jsonDaSonda<boolean>(
      [
        "select 'SONDA|' || to_jsonb(",
        "to_regclass('public.sonda_fidelidade_do_harness') is null and",
        "to_regclass('public.sonda_fidelidade_do_harness_seq') is null and",
        "to_regprocedure('public.fn_sonda_fidelidade_do_harness()') is null)::text;",
      ].join("\n"),
    );
    expect(ausentes).toBe(true);
  });

  it.each(PAPEIS)("o recibo novo é inacessível ao papel da API %s", (papel) => {
    const acesso = jsonDaSonda<boolean>(
      [
        "select 'SONDA|' || to_jsonb(exists(select 1 from unnest(array[",
        [...TABELA_PG15, ...(majorDoServidor() === 17 ? ["MAINTAIN"] : [])]
          .map((p) => "'" + p + "'")
          .join(","),
        "]::text[]) p(privilegio) where has_table_privilege('" + papel + "',",
        "'test_db.acl_do_bootstrap', privilegio)))::text;",
      ].join("\n"),
    );
    expect(acesso).toBe(false);
    let erro: unknown;
    try {
      sql("begin; set local role " + papel + "; select * from test_db.acl_do_bootstrap; rollback;");
    } catch (err) {
      erro = err;
    }
    expect(erro).toBeDefined();
    expect(motivoDoErro(erro)).toMatch(/permission denied/i);
  });

  it("um REVOKE final legítimo não desfaz a prova anterior; o controle faz rollback", () => {
    const acl = () =>
      jsonDaSonda<string>(
        "select 'SONDA|' || to_jsonb(coalesce(relacl::text,''))::text from pg_class " +
          "where oid='public.event_log'::regclass;",
      );
    const antes = acl();
    const controle = jsonDaSonda<{ revogado_direto: boolean; recibo: unknown }>(
      [
        "begin;",
        "revoke delete on public.event_log from authenticated;",
        "select 'SONDA|' || jsonb_build_object(",
        "'revogado_direto', not exists(select 1 from pg_class c, aclexplode(c.relacl) a",
        "where c.oid='public.event_log'::regclass and a.grantee='authenticated'::regrole",
        "and a.privilege_type='DELETE'), 'recibo', " + RECIBO_JSON + ")::text;",
        "rollback;",
      ].join("\n"),
    );
    expect(controle.revogado_direto).toBe(true);
    expect(() => conferirRecibo(controle.recibo, majorDoServidor())).not.toThrow();
    expect(acl()).toBe(antes);
  });

  it("o audit log mantém a negação de UPDATE, DELETE e TRUNCATE nos três papéis", () => {
    for (const papel of PAPEIS) {
      const acesso = aclsFinais("api_audit_log", papel, ["UPDATE", "DELETE", "TRUNCATE"]);
      expect(acesso.diretos, papel).toEqual([]);
      expect(acesso.efetivos, papel).toEqual([]);
    }
  });

  it("idempotency_keys conserva o contrato específico de TRUNCATE por papel", () => {
    for (const papel of PAPEIS) {
      const esperado = papel === "service_role" ? ["TRUNCATE"] : [];
      const acesso = aclsFinais("idempotency_keys", papel, ["TRUNCATE"]);
      expect(acesso.diretos, papel).toEqual(esperado);
      expect(acesso.efetivos, papel).toEqual(esperado);
    }
  });
});
