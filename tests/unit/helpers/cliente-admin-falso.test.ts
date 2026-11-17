// @vitest-environment node
/**
 * O PRÓPRIO CLIENTE ADMIN FALSO, MEDIDO (Spec 33, fatias R).
 *
 * `cliente-admin-falso.ts` é a régua que as rotas com token usam para provar que
 * o filtro de `organization_id` existe. Uma régua torta dá verde falso em toda
 * rota que a usa, então cada regra do dublê tem aqui um caso que a nomeia: se
 * alguém afrouxar uma delas, o vermelho aparece neste arquivo e não, muito
 * depois, em produção.
 */
import { describe, expect, it } from "vitest";

import {
  arquivosForaDaOrganizacao,
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  rpcsForaDaOrganizacao,
  type ArquivoRegistrado,
  type OpcoesDoFalso,
} from "@/tests/unit/helpers/cliente-admin-falso";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Linha = Record<string, unknown>;
type Resultado = { data: unknown; error: unknown; count: number | null; status: number };

/** O mínimo do cliente que estes casos usam. O dublê devolve `unknown`; aqui ele ganha forma. */
interface Consulta extends PromiseLike<Resultado> {
  select(colunas?: string, opcoes?: { count?: string; head?: boolean }): Consulta;
  insert(payload: unknown): Consulta;
  upsert(payload: unknown): Consulta;
  update(payload: unknown): Consulta;
  delete(): Consulta;
  eq(coluna: string, valor: unknown): Consulta;
  neq(coluna: string, valor: unknown): Consulta;
  in(coluna: string, valores: readonly unknown[]): Consulta;
  is(coluna: string, valor: unknown): Consulta;
  match(valores: Record<string, unknown>): Consulta;
  gt(coluna: string, valor: unknown): Consulta;
  gte(coluna: string, valor: unknown): Consulta;
  lt(coluna: string, valor: unknown): Consulta;
  lte(coluna: string, valor: unknown): Consulta;
  like(coluna: string, valor: unknown): Consulta;
  ilike(coluna: string, valor: unknown): Consulta;
  contains(coluna: string, valor: unknown): Consulta;
  or(expressao: string): Consulta;
  not(coluna: string, operador: string, valor: unknown): Consulta;
  filter(coluna: string, operador: string, valor: unknown): Consulta;
  limit(n: number): Consulta;
  range(de: number, ate: number): Consulta;
  single(): Consulta;
  maybeSingle(): Consulta;
}

interface ChamadaRpc extends PromiseLike<Resultado> {
  single(): ChamadaRpc;
  maybeSingle(): ChamadaRpc;
}

interface Balde {
  upload(caminho: string, corpo?: unknown, opcoes?: unknown): Promise<{ data: unknown; error: unknown }>;
  download(caminho: string): Promise<{ data: unknown; error: unknown }>;
  remove(caminhos: string[]): Promise<{ data: unknown; error: unknown }>;
  createSignedUrl(caminho: string, segundos?: number): Promise<{ data: unknown; error: unknown }>;
  list(prefixo?: string): Promise<{ data: unknown; error: unknown }>;
}

interface Db {
  from(tabela: string): Consulta;
  rpc(nome: string, args?: Record<string, unknown>): ChamadaRpc;
  storage: { from(bucket: string): Balde };
}

/** Para chamar o que o dublê NÃO implementa sem o tipo reclamar. */
type Aberto = Record<string, () => unknown>;

/** Três contatos de A e um de B, na mesma tabela. */
function contatos(): Linha[] {
  return [
    { id: "c1", organization_id: ORG_A, nome: "Ana", status: "novo", n: 1, nota: null },
    { id: "c2", organization_id: ORG_A, nome: "Bia", status: "aberto", n: 2, nota: "x" },
    { id: "c3", organization_id: ORG_A, nome: "Caio", status: "aberto", n: 3, nota: "y" },
    { id: "c4", organization_id: ORG_B, nome: "Dora", status: "novo", n: 1, nota: null },
  ];
}

function novo(opcoes: Partial<OpcoesDoFalso> = {}) {
  const falso = criarClienteAdminFalso({ orgDona: ORG_A, ...opcoes });
  return { ...falso, db: falso.cliente as Db };
}

function idsDe(resultado: Resultado): string[] {
  return (resultado.data as Linha[]).map((linha) => String(linha.id));
}

const FORMA_DE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("cliente admin falso — registro da cadeia", () => {
  it("registra a cadeia (tabela, operação e filtros) antes do await", async () => {
    const { db, cadeias } = novo({ linhas: { contacts: contatos() } });
    const consulta = db.from("contacts").select("*").eq("organization_id", ORG_A);

    expect(cadeias).toEqual([
      { tabela: "contacts", operacao: "select", filtros: [["organization_id", ORG_A]] },
    ]);

    const resultado = await consulta;
    expect(resultado.error).toBeNull();
    expect(cadeias).toHaveLength(1);
  });

  it("só executa a cadeia quando ela é aguardada: o insert não grava antes do await", async () => {
    const { db, linhas } = novo({ linhas: { contacts: contatos() } });
    const insercao = db.from("contacts").insert({ organization_id: ORG_A, nome: "Eva" });

    expect(linhas.contacts).toHaveLength(4);
    await insercao;
    expect(linhas.contacts).toHaveLength(5);
  });

  it("aguardar a mesma cadeia duas vezes executa uma vez só", async () => {
    const { db, linhas } = novo({ linhas: { contacts: contatos() } });
    const insercao = db.from("contacts").insert({ organization_id: ORG_A, nome: "Unico" });

    await insercao;
    await insercao;

    expect(linhas.contacts?.filter((linha) => linha.nome === "Unico")).toHaveLength(1);
  });
});

describe("cliente admin falso — o que a cadeia alcança", () => {
  it("select com eq de organization_id devolve só as linhas da organização, nunca a de B", async () => {
    const { db } = novo({ linhas: { contacts: contatos() } });
    const resultado = await db.from("contacts").select("*").eq("organization_id", ORG_A);

    expect(idsDe(resultado)).toEqual(["c1", "c2", "c3"]);
    expect(resultado.data).not.toContainEqual(expect.objectContaining({ organization_id: ORG_B }));
  });

  it("o mesmo select filtrado por B devolve só a linha de B (a linha de B existe no dublê)", async () => {
    const { db } = novo({ linhas: { contacts: contatos() } });
    const resultado = await db.from("contacts").select("*").eq("organization_id", ORG_B);

    expect(idsDe(resultado)).toEqual(["c4"]);
  });

  it("select sem filtro de organização não alcança linha nenhuma e a cadeia é acusada", async () => {
    const { db, cadeias } = novo({ linhas: { contacts: contatos() } });
    const resultado = await db.from("contacts").select("*").eq("id", "c4");

    expect(resultado.data).toEqual([]);
    expect(cadeias).toHaveLength(1);
    expect(cadeiasForaDaOrganizacao(cadeias, ORG_A)).toEqual(cadeias);
  });

  it("tabela em tabelasSemOrganizacao alcança a linha sem o filtro e não é acusada", async () => {
    const tabelasSemOrganizacao = ["calendar_service_schedule"];
    const { db, cadeias } = novo({
      linhas: { calendar_service_schedule: [{ id: "h1", event_type_id: "t1" }] },
      tabelasSemOrganizacao,
    });
    const resultado = await db.from("calendar_service_schedule").select("*").eq("event_type_id", "t1");

    expect(idsDe(resultado)).toEqual(["h1"]);
    expect(cadeiasForaDaOrganizacao(cadeias, ORG_A, { tabelasSemOrganizacao })).toEqual([]);
    // Sem a declaração, a MESMA cadeia seria acusada: é ela que a perdoa.
    expect(cadeiasForaDaOrganizacao(cadeias, ORG_A)).toEqual(cadeias);
  });

  it("organizations com eq de id alcança a linha da organização e não é acusada", async () => {
    const { db, cadeias } = novo({
      linhas: { organizations: [{ id: ORG_A, nome: "Org A" }, { id: ORG_B, nome: "Org B" }] },
    });
    const resultado = await db.from("organizations").select("*").eq("id", ORG_A);

    expect(idsDe(resultado)).toEqual([ORG_A]);
    expect(cadeiasForaDaOrganizacao(cadeias, ORG_A)).toEqual([]);
  });

  it("organizations filtrada pelo id de outra organização é acusada", async () => {
    const { db, cadeias } = novo({
      linhas: { organizations: [{ id: ORG_A, nome: "Org A" }, { id: ORG_B, nome: "Org B" }] },
    });
    await db.from("organizations").select("*").eq("id", ORG_B);

    expect(cadeiasForaDaOrganizacao(cadeias, ORG_A)).toEqual(cadeias);
  });
});

describe("cliente admin falso — filtros", () => {
  const APLICADOS: Array<[nome: string, aplicar: (q: Consulta) => Consulta, esperados: string[]]> = [
    ["eq", (q) => q.eq("status", "novo"), ["c1"]],
    ["neq", (q) => q.neq("status", "novo"), ["c2", "c3"]],
    ["in", (q) => q.in("id", ["c1", "c3"]), ["c1", "c3"]],
    ["is com nulo", (q) => q.is("nota", null), ["c1"]],
    ["match", (q) => q.match({ status: "aberto", n: 3 }), ["c3"]],
    ["gt", (q) => q.gt("n", 1), ["c2", "c3"]],
    ["gte", (q) => q.gte("n", 2), ["c2", "c3"]],
    ["lt", (q) => q.lt("n", 3), ["c1", "c2"]],
    ["lte", (q) => q.lte("n", 2), ["c1", "c2"]],
  ];

  it.each(APLICADOS)("%s aplica o filtro sobre as linhas da organização", async (_nome, aplicar, esperados) => {
    const { db } = novo({ linhas: { contacts: contatos() } });
    const resultado = await aplicar(db.from("contacts").select("*").eq("organization_id", ORG_A));

    expect(idsDe(resultado)).toEqual(esperados);
  });

  const SO_REGISTRADOS: Array<[nome: string, aplicar: (q: Consulta) => Consulta, filtro: [string, unknown]]> = [
    ["like", (q) => q.like("nome", "A%"), ["nome", "A%"]],
    ["ilike", (q) => q.ilike("nome", "a%"), ["nome", "a%"]],
    ["or", (q) => q.or("status.eq.novo,status.eq.aberto"), ["or", "status.eq.novo,status.eq.aberto"]],
    ["not", (q) => q.not("status", "eq", "novo"), ["status", { not: ["eq", "novo"] }]],
    ["filter", (q) => q.filter("n", "gt", 1), ["n", "gt.1"]],
    ["contains", (q) => q.contains("tags", ["vip"]), ["tags", ["vip"]]],
  ];

  it.each(SO_REGISTRADOS)("%s só registra o filtro e não restringe as linhas", async (_nome, aplicar, filtro) => {
    const { db, cadeias } = novo({ linhas: { contacts: contatos() } });
    const resultado = await aplicar(db.from("contacts").select("*").eq("organization_id", ORG_A));

    expect(idsDe(resultado)).toEqual(["c1", "c2", "c3"]);
    expect(cadeias[0]?.filtros).toContainEqual(filtro);
  });

  it("limit e range cortam o resultado depois dos filtros", async () => {
    const { db } = novo({ linhas: { contacts: contatos() } });
    const limitado = await db.from("contacts").select("*").eq("organization_id", ORG_A).limit(2);
    const paginado = await db.from("contacts").select("*").eq("organization_id", ORG_A).range(1, 2);

    expect(idsDe(limitado)).toEqual(["c1", "c2"]);
    expect(idsDe(paginado)).toEqual(["c2", "c3"]);
  });
});

describe("cliente admin falso — single, maybeSingle e contagem", () => {
  it("single com uma linha devolve a linha em data, sem erro", async () => {
    const { db } = novo({ linhas: { contacts: contatos() } });
    const resultado = await db.from("contacts").select("*").eq("organization_id", ORG_A).eq("id", "c1").single();

    expect(resultado.error).toBeNull();
    expect(resultado.data).toMatchObject({ id: "c1", nome: "Ana", organization_id: ORG_A });
  });

  it("single sem nenhuma linha devolve o erro PGRST116 e data nulo", async () => {
    const { db } = novo({ linhas: { contacts: contatos() } });
    const resultado = await db.from("contacts").select("*").eq("organization_id", ORG_A).eq("id", "zzz").single();

    expect(resultado.data).toBeNull();
    expect(resultado.error).toMatchObject({ code: "PGRST116" });
  });

  it("single com mais de uma linha também devolve PGRST116", async () => {
    const { db } = novo({ linhas: { contacts: contatos() } });
    const resultado = await db.from("contacts").select("*").eq("organization_id", ORG_A).single();

    expect(resultado.data).toBeNull();
    expect(resultado.error).toMatchObject({ code: "PGRST116" });
  });

  it("maybeSingle sem nenhuma linha devolve data nulo e SEM erro", async () => {
    const { db } = novo({ linhas: { contacts: contatos() } });
    const resultado = await db
      .from("contacts")
      .select("*")
      .eq("organization_id", ORG_A)
      .eq("id", "zzz")
      .maybeSingle();

    expect(resultado.data).toBeNull();
    expect(resultado.error).toBeNull();
  });

  it("maybeSingle com uma linha devolve a linha", async () => {
    const { db } = novo({ linhas: { contacts: contatos() } });
    const resultado = await db
      .from("contacts")
      .select("*")
      .eq("organization_id", ORG_A)
      .eq("id", "c2")
      .maybeSingle();

    expect(resultado.error).toBeNull();
    expect(resultado.data).toMatchObject({ id: "c2", nome: "Bia" });
  });

  it("select com count exact e head devolve data nulo e a contagem das linhas da organização", async () => {
    const { db } = novo({ linhas: { contacts: contatos() } });
    const resultado = await db
      .from("contacts")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", ORG_A);

    expect(resultado.data).toBeNull();
    expect(resultado.error).toBeNull();
    expect(resultado.count).toBe(3);
  });

  it("select com count exact sem head devolve as linhas e a contagem", async () => {
    const { db } = novo({ linhas: { contacts: contatos() } });
    const resultado = await db
      .from("contacts")
      .select("*", { count: "exact" })
      .eq("organization_id", ORG_A);

    expect(idsDe(resultado)).toEqual(["c1", "c2", "c3"]);
    expect(resultado.count).toBe(3);
  });

  it("select sem count devolve count nulo", async () => {
    const { db } = novo({ linhas: { contacts: contatos() } });
    const resultado = await db.from("contacts").select("*").eq("organization_id", ORG_A);

    expect(resultado.count).toBeNull();
  });
});

describe("cliente admin falso — insert e upsert", () => {
  it("insert sem organization_id no payload é acusado", async () => {
    const { db, cadeias } = novo();
    await db.from("contacts").insert({ nome: "Sem org" });

    expect(cadeiasForaDaOrganizacao(cadeias, ORG_A)).toEqual(cadeias);
  });

  it("insert com o organization_id de B é acusado quando a organização é A", async () => {
    const { db, cadeias } = novo();
    await db.from("contacts").insert({ organization_id: ORG_B, nome: "De B" });

    expect(cadeiasForaDaOrganizacao(cadeias, ORG_A)).toEqual(cadeias);
  });

  it("insert com o organization_id da organização não é acusado", async () => {
    const { db, cadeias } = novo();
    await db.from("contacts").insert({ organization_id: ORG_A, nome: "De A" });

    expect(cadeiasForaDaOrganizacao(cadeias, ORG_A)).toEqual([]);
  });

  it("insert de várias linhas é acusado se UMA delas é de outra organização", async () => {
    const { db, cadeias } = novo();
    await db.from("contacts").insert([
      { organization_id: ORG_A, nome: "De A" },
      { organization_id: ORG_B, nome: "De B" },
    ]);

    expect(cadeiasForaDaOrganizacao(cadeias, ORG_A)).toEqual(cadeias);
  });

  it("insert sem select não devolve linhas em data", async () => {
    const { db } = novo();
    const resultado = await db.from("contacts").insert({ organization_id: ORG_A, nome: "Eva" });

    expect(resultado.error).toBeNull();
    expect(resultado.data).toBeNull();
  });

  it("insert seguido de select e single devolve a linha com id, e ela aparece em linhas[tabela]", async () => {
    const { db, cadeias, linhas } = novo({ linhas: { contacts: contatos() } });
    const resultado = await db
      .from("contacts")
      .insert({ organization_id: ORG_A, nome: "Eva" })
      .select()
      .single();
    const gravada = resultado.data as Linha;

    expect(resultado.error).toBeNull();
    expect(gravada).toMatchObject({ organization_id: ORG_A, nome: "Eva" });
    expect(gravada.id).toEqual(expect.stringMatching(FORMA_DE_UUID));
    expect(linhas.contacts).toContainEqual(gravada);
    expect(cadeias[0]).toMatchObject({
      operacao: "insert",
      payload: { organization_id: ORG_A, nome: "Eva" },
    });
  });

  it("upsert com id existente atualiza a linha em vez de duplicar", async () => {
    const { db, linhas } = novo({ linhas: { contacts: contatos() } });
    await db.from("contacts").upsert({ id: "c1", organization_id: ORG_A, nome: "Ana Maria" });

    expect(linhas.contacts).toHaveLength(4);
    expect(linhas.contacts?.find((linha) => linha.id === "c1")).toMatchObject({
      nome: "Ana Maria",
      status: "novo",
    });
  });

  it("upsert com id novo insere a linha", async () => {
    const { db, linhas } = novo({ linhas: { contacts: contatos() } });
    await db.from("contacts").upsert({ id: "c9", organization_id: ORG_A, nome: "Nova" });

    expect(linhas.contacts).toHaveLength(5);
    expect(linhas.contacts?.find((linha) => linha.id === "c9")).toMatchObject({ nome: "Nova" });
  });

  it("upsert de outra organização é acusado", async () => {
    const { db, cadeias } = novo();
    await db.from("contacts").upsert({ id: "c9", organization_id: ORG_B, nome: "De B" });

    expect(cadeiasForaDaOrganizacao(cadeias, ORG_A)).toEqual(cadeias);
  });
});

describe("cliente admin falso — update e delete", () => {
  it("update com o filtro da organização mescla o payload na linha e preserva as outras colunas", async () => {
    const { db, linhas } = novo({ linhas: { contacts: contatos() } });
    const resultado = await db
      .from("contacts")
      .update({ status: "fechado" })
      .eq("organization_id", ORG_A)
      .eq("id", "c1")
      .select();

    expect(idsDe(resultado)).toEqual(["c1"]);
    expect(linhas.contacts?.find((linha) => linha.id === "c1")).toMatchObject({
      status: "fechado",
      nome: "Ana",
    });
  });

  it("update que mira a linha de B com o filtro de A não altera nada", async () => {
    const { db, linhas } = novo({ linhas: { contacts: contatos() } });
    const resultado = await db
      .from("contacts")
      .update({ status: "fechado" })
      .eq("organization_id", ORG_A)
      .eq("id", "c4")
      .select();

    expect(resultado.data).toEqual([]);
    expect(linhas.contacts?.find((linha) => linha.id === "c4")).toMatchObject({ status: "novo" });
  });

  it("update sem o filtro de organização não alcança linha e é acusado", async () => {
    const { db, cadeias, linhas } = novo({ linhas: { contacts: contatos() } });
    await db.from("contacts").update({ status: "fechado" }).eq("id", "c1");

    expect(linhas.contacts?.find((linha) => linha.id === "c1")).toMatchObject({ status: "novo" });
    expect(cadeiasForaDaOrganizacao(cadeias, ORG_A)).toEqual(cadeias);
  });

  it("update que troca organization_id para outra organização é acusado mesmo com o filtro", async () => {
    const { db, cadeias } = novo({ linhas: { contacts: contatos() } });
    await db
      .from("contacts")
      .update({ organization_id: ORG_B })
      .eq("organization_id", ORG_A)
      .eq("id", "c1");

    expect(cadeiasForaDaOrganizacao(cadeias, ORG_A)).toEqual(cadeias);
  });

  it("update que reafirma a própria organização, com o filtro, não é acusado", async () => {
    const { db, cadeias } = novo({ linhas: { contacts: contatos() } });
    await db
      .from("contacts")
      .update({ organization_id: ORG_A, status: "fechado" })
      .eq("organization_id", ORG_A)
      .eq("id", "c1");

    expect(cadeiasForaDaOrganizacao(cadeias, ORG_A)).toEqual([]);
  });

  it("delete com o filtro da organização tira a linha e só ela", async () => {
    const { db, linhas } = novo({ linhas: { contacts: contatos() } });
    const resultado = await db.from("contacts").delete().eq("organization_id", ORG_A).eq("id", "c1");

    expect(resultado.error).toBeNull();
    expect(linhas.contacts?.map((linha) => linha.id)).toEqual(["c2", "c3", "c4"]);
  });

  it("delete sem o filtro de organização não tira nada e é acusado", async () => {
    const { db, cadeias, linhas } = novo({ linhas: { contacts: contatos() } });
    await db.from("contacts").delete().eq("id", "c1");

    expect(linhas.contacts).toHaveLength(4);
    expect(cadeiasForaDaOrganizacao(cadeias, ORG_A)).toEqual(cadeias);
  });
});

describe("cliente admin falso — cadeiasDeEscrita", () => {
  it("devolve só as cadeias que não são select, na ordem em que foram criadas", async () => {
    const { db, cadeias } = novo({ linhas: { contacts: contatos() } });
    await db.from("contacts").select("*").eq("organization_id", ORG_A);
    await db.from("contacts").insert({ organization_id: ORG_A, nome: "Eva" });
    await db.from("contacts").update({ nome: "Ana 2" }).eq("organization_id", ORG_A).eq("id", "c1");
    await db.from("contacts").upsert({ organization_id: ORG_A, nome: "Fabio" });
    await db.from("contacts").delete().eq("organization_id", ORG_A).eq("id", "c2");

    expect(cadeias).toHaveLength(5);
    expect(cadeiasDeEscrita(cadeias).map((cadeia) => cadeia.operacao)).toEqual([
      "insert",
      "update",
      "upsert",
      "delete",
    ]);
  });

  it("devolve lista vazia quando só houve leitura", async () => {
    const { db, cadeias } = novo({ linhas: { contacts: contatos() } });
    await db.from("contacts").select("*").eq("organization_id", ORG_A);

    expect(cadeiasDeEscrita(cadeias)).toEqual([]);
  });
});

describe("cliente admin falso — rpc", () => {
  it("registra o nome e os argumentos da chamada", async () => {
    const { db, rpcs } = novo();
    await db.rpc("fn_qualquer", { p_org: ORG_A, p_valor: 1 });

    expect(rpcs).toEqual([{ nome: "fn_qualquer", args: { p_org: ORG_A, p_valor: 1 } }]);
  });

  it("sem valor configurado resolve data nulo e sem erro", async () => {
    const { db } = novo();
    const resultado = await db.rpc("fn_nao_configurada", { p_org: ORG_A });

    expect(resultado.data).toBeNull();
    expect(resultado.error).toBeNull();
  });

  it("resolve o valor configurado para o nome da função", async () => {
    const { db } = novo({ rpc: { fn_lista: [{ id: 1 }, { id: 2 }] } });
    const resultado = await db.rpc("fn_lista", { p_org: ORG_A });

    expect(resultado.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(resultado.error).toBeNull();
  });

  it("resolve o retorno da função configurada, que recebe os argumentos", async () => {
    const { db } = novo({
      rpc: { fn_eco: (args: Record<string, unknown>) => ({ data: { recebido: args.p_org } }) },
    });
    const resultado = await db.rpc("fn_eco", { p_org: ORG_A });

    expect(resultado.data).toEqual({ recebido: ORG_A });
    expect(resultado.error).toBeNull();
  });

  it("devolve o erro da função configurada com data nulo", async () => {
    const { db } = novo({
      rpc: { fn_nega: () => ({ error: { code: "42501", message: "service_actor_forbidden" } }) },
    });
    const resultado = await db.rpc("fn_nega", { p_org: ORG_A });

    expect(resultado.data).toBeNull();
    expect(resultado.error).toMatchObject({ code: "42501" });
  });

  it("aceita encadear single e maybeSingle sem lançar", async () => {
    const { db } = novo({ rpc: { fn_um: { id: 7 } } });
    const unico = await db.rpc("fn_um", { p_org: ORG_A }).single();
    const talvez = await db.rpc("fn_um", { p_org: ORG_A }).maybeSingle();

    expect(unico.data).toEqual({ id: 7 });
    expect(talvez.data).toEqual({ id: 7 });
  });

  it.each(["p_org", "p_org_id", "p_organization_id", "organization_id"])(
    "rpcsForaDaOrganizacao acusa a chamada cujo %s é de outra organização",
    async (chave) => {
      const { db, rpcs } = novo();
      await db.rpc("fn_de_b", { [chave]: ORG_B });

      expect(rpcsForaDaOrganizacao(rpcs, ORG_A)).toEqual(["fn_de_b"]);
    },
  );

  it("rpcsForaDaOrganizacao não acusa a chamada com a organização certa", async () => {
    const { db, rpcs } = novo();
    await db.rpc("fn_de_a", { p_org: ORG_A });

    expect(rpcsForaDaOrganizacao(rpcs, ORG_A)).toEqual([]);
  });

  it("rpcsForaDaOrganizacao ignora argumento de organização nulo ou ausente", async () => {
    const { db, rpcs } = novo();
    await db.rpc("fn_nula", { p_org: null });
    await db.rpc("fn_sem_org", { p_valor: 1 });

    expect(rpcsForaDaOrganizacao(rpcs, ORG_A)).toEqual([]);
  });

  it("rpcsForaDaOrganizacao lista o nome de cada chamada de outra organização, na ordem", async () => {
    const { db, rpcs } = novo();
    await db.rpc("fn_ok", { p_org: ORG_A });
    await db.rpc("fn_ruim_1", { p_org: ORG_B });
    await db.rpc("fn_ruim_2", { p_organization_id: ORG_B });

    expect(rpcsForaDaOrganizacao(rpcs, ORG_A)).toEqual(["fn_ruim_1", "fn_ruim_2"]);
  });
});

describe("cliente admin falso — storage", () => {
  it("upload registra o bucket, o caminho e a operação", async () => {
    const { db, uploads } = novo();
    const caminho = `${ORG_A}/conversa/anexo.png`;
    const resultado = await db.storage
      .from("internal-media")
      .upload(caminho, new Uint8Array([1, 2]), { contentType: "image/png" });

    expect(resultado.error).toBeNull();
    expect(resultado.data).toMatchObject({ path: caminho });
    expect(uploads).toEqual([{ bucket: "internal-media", caminho, operacao: "upload" }]);
  });

  it("download, remove, createSignedUrl e list ficam registrados com o nome da operação", async () => {
    const { db, uploads } = novo();
    const balde = db.storage.from("whatsapp-media");
    await balde.download("p/1");
    await balde.remove(["p/2", "p/3"]);
    await balde.createSignedUrl("p/4", 60);
    await balde.list("p");

    expect(uploads).toEqual([
      { bucket: "whatsapp-media", caminho: "p/1", operacao: "download" },
      { bucket: "whatsapp-media", caminho: "p/2", operacao: "remove" },
      { bucket: "whatsapp-media", caminho: "p/3", operacao: "remove" },
      { bucket: "whatsapp-media", caminho: "p/4", operacao: "createSignedUrl" },
      { bucket: "whatsapp-media", caminho: "p", operacao: "list" },
    ]);
  });

  const arquivo = (caminho: string): ArquivoRegistrado => ({ bucket: "internal-media", caminho, operacao: "upload" });

  it("arquivosForaDaOrganizacao não acusa caminho que tem a organização como segmento", () => {
    const uploads = [arquivo(`${ORG_A}/c/a.png`), arquivo(`internal/${ORG_A}/c/b.png`)];

    expect(arquivosForaDaOrganizacao(uploads, ORG_A)).toEqual([]);
  });

  it("arquivosForaDaOrganizacao acusa caminho de outra organização", () => {
    const deB = arquivo(`${ORG_B}/c/a.png`);

    expect(arquivosForaDaOrganizacao([deB], ORG_A)).toEqual([deB]);
  });

  it("arquivosForaDaOrganizacao acusa caminho sem nenhum segmento de organização", () => {
    const solto = arquivo("c/a.png");

    expect(arquivosForaDaOrganizacao([solto], ORG_A)).toEqual([solto]);
  });

  it("arquivosForaDaOrganizacao acusa caminho em que a organização é só prefixo de um segmento", () => {
    const parecido = arquivo(`${ORG_A}-copia/c/a.png`);

    expect(arquivosForaDaOrganizacao([parecido], ORG_A)).toEqual([parecido]);
  });
});

describe("cliente admin falso — método que o dublê não conhece", () => {
  const chamar = (alvo: unknown, nome: string): unknown => (alvo as Aberto)[nome]!();

  const DESCONHECIDOS: Array<[onde: string, executar: (db: Db) => unknown, mensagem: string]> = [
    ["no cliente", (db) => chamar(db, "naoExiste"), "método naoExiste não suportado pelo cliente falso (cliente)"],
    [
      "na cadeia",
      (db) => chamar(db.from("contacts"), "naoExiste"),
      'método naoExiste não suportado pelo cliente falso (from("contacts"))',
    ],
    [
      "na cadeia depois de um filtro",
      (db) => chamar(db.from("contacts").eq("organization_id", ORG_A), "naoExiste"),
      'método naoExiste não suportado pelo cliente falso (from("contacts"))',
    ],
    [
      "na chamada de rpc",
      (db) => chamar(db.rpc("fn_x"), "naoExiste"),
      'método naoExiste não suportado pelo cliente falso (rpc("fn_x"))',
    ],
    [
      "no storage",
      (db) => chamar(db.storage, "naoExiste"),
      "método naoExiste não suportado pelo cliente falso (storage)",
    ],
    [
      "no balde do storage",
      (db) => chamar(db.storage.from("internal-media"), "naoExiste"),
      'método naoExiste não suportado pelo cliente falso (storage.from("internal-media"))',
    ],
    [
      "em auth.admin",
      (db) => chamar((db as unknown as { auth: { admin: unknown } }).auth.admin, "listUsers"),
      "método listUsers não suportado pelo cliente falso (auth.admin)",
    ],
  ];

  it.each(DESCONHECIDOS)("método desconhecido %s lança com o nome dele", (_onde, executar, mensagem) => {
    const { db } = novo();

    expect(() => executar(db)).toThrow(mensagem);
  });
});

describe("cliente admin falso — o cliente em si não é thenable", () => {
  it("aguardar o próprio cliente (Promise.resolve) não lança e devolve o mesmo cliente", async () => {
    const { cliente } = novo();
    const resolvido = await Promise.resolve(cliente);

    expect(Object.is(resolvido, cliente)).toBe(true);
  });
});
