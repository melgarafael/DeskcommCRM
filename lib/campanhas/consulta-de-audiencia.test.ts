import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { FILTRO_VAZIO, type FiltroDeAudiencia } from "./audiencia";
import { buscarCandidatos } from "./consulta-de-audiencia";

/**
 * A AUDIÊNCIA NÃO PODE DERRUBAR A PREPARAÇÃO, PERDER O NEGÓCIO MAIS NOVO NEM
 * PARAR CEDO NA LEITURA.
 *
 * Três gerações do mesmo caminho:
 *
 * 1. `{{lead.x}}` com os ids de TODA a audiência num único `in (...)` dava
 *    ~19,7 KB de URL e o gateway (Kong 2.8.1) devolvia `414` acima de 8.192 B.
 * 2. A consulta de contatos punha os ids de negócio do recorte (até 20.000) na
 *    mesma URL, e a de ids de negócio parava no `max_rows` sem paginar.
 * 3. As páginas por `range` paravam na "página curta": com `max_rows` da
 *    instalação abaixo de `PAGINA_DO_POSTGREST` a primeira página já volta
 *    curta, e a leitura parava cedo em silêncio. Agora a paginação é KEYSEET em
 *    (`created_at`, `id`), e só a página VAZIA prova o fim.
 *
 * Aqui a URL sai do `postgrest-js` de verdade e um PostgREST falso aplica
 * filtro, `order` (e a AUSÊNCIA dele), todo `or` (keyset inclusive) e o corte de `max_rows`.
 */

const MURO_DO_GATEWAY = 8_192;
const MAX_ROWS = 1_000;
const uuid = (i: number, p = "1111") => `${String(i).padStart(8, "0")}-${p}-4111-8111-111111111111`;
const ORG = uuid(999, "9999");

interface Negocio {
  id: string;
  contact_id: string;
  created_at: string;
  custom_fields: Record<string, unknown>;
}

function json(corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Ordem ordinal — a mesma do `ORDER BY` do Postgres para estes campos. */
const ord = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * O `order` da consulta vira a ordenação do dublê, e a AUSÊNCIA dele vira a
 * ordem de inserção — como no PostgREST real. Sem isso, tirar um `.order(…)`
 * de produção não deixa nenhum teste vermelho (#2404): o dublê ordenava por
 * conta própria e escondia a falta.
 */
function aplicarOrdem<T extends Record<string, unknown>>(linhas: T[], order: string | null): T[] {
  if (!order) return [...linhas];
  const chaves = order.split(",").map((parte) => {
    const [col, dir] = parte.split(".");
    return { col: col!, desc: dir === "desc" };
  });
  return [...linhas].sort((a, b) => {
    for (const { col, desc } of chaves) {
      const c = ord(String(a[col]), String(b[col]));
      if (c !== 0) return desc ? -c : c;
    }
    return 0;
  });
}

/** Separa `a,and(b,c),d` nas vírgulas de fora dos parênteses. */
function termosDoOr(filtro: string): string[] {
  const termos: string[] = [];
  let nivel = 0;
  let inicio = 0;
  for (let i = 0; i < filtro.length; i++) {
    if (filtro[i] === "(") nivel++;
    else if (filtro[i] === ")") nivel--;
    else if (filtro[i] === "," && nivel === 0) {
      termos.push(filtro.slice(inicio, i));
      inicio = i + 1;
    }
  }
  termos.push(filtro.slice(inicio));
  return termos;
}

function atende(linha: Record<string, unknown>, termo: string): boolean {
  if (termo.startsWith("and(") && termo.endsWith(")")) {
    return termosDoOr(termo.slice(4, -1)).every((t) => atende(linha, t));
  }
  const [col, op, ...resto] = termo.split(".");
  const valor = resto.join(".");
  const atual = linha[col!];
  if (op === "is" && valor === "null") return atual == null;
  if (atual == null) return false;
  const c = ord(String(atual), valor);
  if (op === "eq") return c === 0;
  if (op === "gt") return c > 0;
  if (op === "lt") return c < 0;
  // Operador que o dublê não conhece não pode virar "passa tudo" em silêncio.
  throw new Error(`dublê: operador desconhecido em or=${termo}`);
}

/**
 * TODO `or=` da consulta (`getAll`, não só o último), termo a termo — o keyset
 * `created_at.gt.…,and(created_at.eq.…,id.gt.…)` e o de silêncio inclusive.
 * Um dublê que só reconhecesse o keyset INTEIRO ignoraria o `or` mutilado (sem
 * o ramo `and(…)`) e devolveria tudo; o vermelho viria da guarda de "não
 * avançou", e não da perda de contatos que é o defeito real.
 */
function aplicarOr<T extends Record<string, unknown>>(linhas: T[], ors: string[]): T[] {
  return ors.reduce((acc, orParam) => {
    const filtro = orParam.startsWith("(") && orParam.endsWith(")") ? orParam.slice(1, -1) : orParam;
    const termos = termosDoOr(filtro);
    return acc.filter((l) => termos.some((t) => atende(l, t)));
  }, linhas);
}

/** Um PostgREST de mentira, com o comportamento que importa aqui. */
function bancoFalso(
  contatos: string[],
  negocios: Negocio[],
  criados: Record<string, string> = {},
  maxRows = MAX_ROWS,
) {
  const urls: string[] = [];
  const contatosBase = contatos.map((id, i) => ({ id, created_at: criados[id] ?? quando(i) }));
  const sb = createClient("http://127.0.0.1:54321", "x".repeat(200), {
    global: {
      fetch: async (entrada: RequestInfo | URL) => {
        const bruta = String(entrada);
        urls.push(bruta);
        const url = new URL(bruta);
        const order = url.searchParams.get("order");
        const or = url.searchParams.getAll("or");
        const limite = Math.min(Number(url.searchParams.get("limit") ?? maxRows), maxRows);
        if (url.pathname.endsWith("/contacts")) {
          // Filtro de `id=in.(…)`, `order`, keyset e o teto de `max_rows`: é o
          // recorte que a consulta de contatos usa. Os outros filtros (tags,
          // origem, datas) não são modelados de propósito — o que se mede aqui
          // é o TAMANHO da URL, a ordem/corte global e o keyset.
          const filtroIds = url.searchParams.getAll("id").find((v) => v.startsWith("in."));
          const permitidos = filtroIds ? new Set(filtroIds.slice(4, -1).split(",")) : null;
          const linhas = aplicarOrdem(
            aplicarOr(
              contatosBase.filter((c) => !permitidos || permitidos.has(c.id)),
              or,
            ),
            order,
          )
            .slice(0, limite)
            .map((c) => ({
              id: c.id,
              created_at: c.created_at,
              name: "Ana Souza",
              display_name: null,
              phone_number: "5511999990000",
              is_blocked: false,
              is_anonymized: false,
              consent: null,
            }));
          return json(linhas);
        }
        const filtroIn = url.searchParams.getAll("contact_id").find((v) => v.startsWith("in."));
        if (!filtroIn) {
          // A consulta dos IDs de negócio do recorte (`select=contact_id`, sem
          // `in (…)`): devolve LINHAS — com repetição — com o `order`/keyset que
          // a consulta pediu.
          const base = negocios.map((n) => ({
            contact_id: n.contact_id,
            created_at: n.created_at,
            id: n.id,
          }));
          return json(aplicarOrdem(aplicarOr(base, or), order).slice(0, limite));
        }
        const ids = new Set(filtroIn.slice(4, -1).split(","));
        const base = negocios
          .filter((n) => ids.has(n.contact_id))
          .map((n) => ({
            contact_id: n.contact_id,
            custom_fields: n.custom_fields,
            created_at: n.created_at,
            id: n.id,
          }));
        const linhas = aplicarOrdem(aplicarOr(base, or), order)
          .slice(0, limite)
          .map(({ contact_id, custom_fields, created_at, id }) => ({
            contact_id,
            custom_fields,
            created_at,
            id,
          }));
        return json(linhas);
      },
    },
  });
  return {
    sb,
    urls,
    urlsDeNegocio: () => urls.filter((u) => u.includes("/crm_leads")),
    urlsDeContatos: () => urls.filter((u) => u.includes("/contacts")),
  };
}

/** Toda consulta do caminho, lote por lote, leva o filtro de organização. */
function cercaDeOrganizacao(banco: ReturnType<typeof bancoFalso>) {
  expect(banco.urls.length).toBeGreaterThan(0);
  for (const u of banco.urls) expect(u).toContain(`organization_id=eq.${ORG}`);
}

const quando = (minutos: number) => new Date(Date.UTC(2026, 0, 1) + minutos * 60_000).toISOString();

async function candidatos(sb: ReturnType<typeof bancoFalso>["sb"]) {
  return (
    await buscarCandidatos(sb, {
      organizationId: ORG,
      filtro: { ...FILTRO_VAZIO, limite: 5000 },
      agora: new Date(Date.UTC(2026, 5, 1)),
      corpo: "Oi {{nome}}, {{lead.gancho}}",
    })
  ).candidatos;
}

describe("negócios dos contatos para {{lead.x}}", () => {
  it("a sonda ENXERGA o estouro: os 500 ids numa URL só passam do muro — controle positivo", async () => {
    const { sb, urls } = bancoFalso([], []);
    const ids = Array.from({ length: 500 }, (_, i) => uuid(i));
    await sb.from("crm_leads").select("contact_id, custom_fields").in("contact_id", ids);
    expect(urls[0]!.length).toBeGreaterThan(MURO_DO_GATEWAY);
  });

  it("audiência de 500: mais de uma consulta, nenhuma URL acima do muro, e todo mundo acha o seu negócio", async () => {
    const contatos = Array.from({ length: 500 }, (_, i) => uuid(i));
    const negocios = contatos.map((c, i) => ({
      id: uuid(i, "2222"),
      contact_id: c,
      created_at: quando(i),
      custom_fields: { gancho: `gancho ${i}` },
    }));
    const banco = bancoFalso(contatos, negocios);

    const lista = await candidatos(banco.sb);

    const urls = banco.urlsDeNegocio();
    expect(urls.length, "os ids foram numa consulta só").toBeGreaterThan(1);
    for (const u of urls) expect(u.length).toBeLessThan(MURO_DO_GATEWAY);
    expect(lista).toHaveLength(500);
    expect(lista.filter((c) => c.lead?.gancho === undefined)).toEqual([]);
    expect(lista[499]!.lead?.gancho).toBe("gancho 499");
  });

  it("contato com muitos negócios no mesmo lote não esconde o mais novo do vizinho", async () => {
    // A tem 1.500 negócios recentes; o único negócio de B é mais antigo que todos.
    // Um `.limit` global, ou o corte de `max_rows` sem paginar, devolve só os de A.
    const [a, b] = [uuid(1), uuid(2)];
    const negocios: Negocio[] = Array.from({ length: 1500 }, (_, i) => ({
      id: uuid(i, "3333"),
      contact_id: a,
      created_at: quando(10_000 + i),
      custom_fields: { gancho: `a ${i}` },
    }));
    negocios.push(
      { id: uuid(1, "4444"), contact_id: b, created_at: quando(5), custom_fields: { gancho: "b velho" } },
      { id: uuid(2, "4444"), contact_id: b, created_at: quando(6), custom_fields: { gancho: "b novo" } },
    );
    const banco = bancoFalso([a, b], negocios);

    const lista = await candidatos(banco.sb);

    expect(lista.find((c) => c.contactId === a)?.lead?.gancho).toBe("a 1499");
    expect(lista.find((c) => c.contactId === b)?.lead?.gancho).toBe("b novo");
  });
});

describe("recorte de funil grande não estoura a URL (#2358)", () => {
  const comFunil = (extra: Partial<FiltroDeAudiencia>) => ({
    ...FILTRO_VAZIO,
    funis: [uuid(900, "8888")],
    ...extra,
  });

  it("a sonda ENXERGA o estouro na consulta de contatos — controle positivo", async () => {
    const { sb, urls } = bancoFalso([], []);
    const ids = Array.from({ length: 500 }, (_, i) => uuid(i));
    await sb.from("contacts").select("id").in("id", ids);
    expect(urls[0]!.length).toBeGreaterThan(MURO_DO_GATEWAY);
  });

  it("funil com 500 contatos: consulta fatiada, nenhuma URL acima do muro, ordem global preservada", async () => {
    const contatos = Array.from({ length: 500 }, (_, i) => uuid(i));
    // Os negócios vêm EMBARALHADOS de propósito: a ordem da resposta só pode
    // vir da ordenação global da consulta, não da ordem dos lotes.
    const negocios = [...contatos]
      .reverse()
      .map((c, i) => ({ id: uuid(i, "2222"), contact_id: c, created_at: quando(i), custom_fields: {} }));
    const banco = bancoFalso(contatos, negocios);

    const { candidatos: lista } = await buscarCandidatos(banco.sb, {
      organizationId: ORG,
      filtro: comFunil({ limite: 500 }),
      agora: new Date(Date.UTC(2026, 5, 1)),
    });

    const urls = banco.urlsDeContatos();
    expect(urls.length, "os ids foram numa consulta só").toBeGreaterThan(1);
    for (const u of urls) expect(u.length).toBeLessThan(MURO_DO_GATEWAY);
    expect(lista.map((c) => c.contactId)).toEqual(contatos);
    cercaDeOrganizacao(banco);
  });

  it("o corte global atravessa lotes: `limite` recorta a união ordenada, não cada lote", async () => {
    const n = 250;
    const contatos = Array.from({ length: n }, (_, i) => uuid(i));
    // `created_at` numa permutação da ordem da lista: os 50 mais velhos ficam
    // espalhados por lotes diferentes.
    const criados: Record<string, string> = {};
    contatos.forEach((c, i) => {
      criados[c] = quando((i * 97) % n);
    });
    const negocios = [...contatos]
      .reverse()
      .map((c, i) => ({ id: uuid(i, "2222"), contact_id: c, created_at: quando(i), custom_fields: {} }));
    const banco = bancoFalso(contatos, negocios, criados);

    const { candidatos: lista } = await buscarCandidatos(banco.sb, {
      organizationId: ORG,
      filtro: comFunil({ limite: 50 }),
      agora: new Date(Date.UTC(2026, 5, 1)),
    });

    const esperado = [...contatos]
      .sort((a, b) => ord(criados[a]!, criados[b]!) || ord(a, b))
      .slice(0, 50);
    expect(lista).toHaveLength(50);
    expect(lista.map((c) => c.contactId)).toEqual(esperado);
    for (const u of banco.urlsDeContatos()) expect(u.length).toBeLessThan(MURO_DO_GATEWAY);
    cercaDeOrganizacao(banco);
  });

  it("excluídos saem da URL e são cortados ANTES do limite (caminho com funil)", async () => {
    const contatos = Array.from({ length: 200 }, (_, i) => uuid(i));
    const negocios = contatos.map((c, i) => ({
      id: uuid(i, "2222"),
      contact_id: c,
      created_at: quando(i),
      custom_fields: {},
    }));
    const banco = bancoFalso(contatos, negocios);

    const { candidatos: lista } = await buscarCandidatos(banco.sb, {
      organizationId: ORG,
      filtro: comFunil({ limite: 50, excluir_contatos: contatos.slice(0, 40) }),
      agora: new Date(Date.UTC(2026, 5, 1)),
    });

    // O corte é DEPOIS da exclusão: os 50 primeiros VÁLIDOS, não 10 + buraco.
    expect(lista.map((c) => c.contactId)).toEqual(contatos.slice(40, 90));
    for (const u of banco.urlsDeContatos()) expect(u).not.toContain("not.in");
    cercaDeOrganizacao(banco);
  });

  it("o mesmo corte com exclusão vale sem filtro de negócio (consulta por keyset)", async () => {
    const contatos = Array.from({ length: 200 }, (_, i) => uuid(i));
    const banco = bancoFalso(contatos, []);

    const { candidatos: lista } = await buscarCandidatos(banco.sb, {
      organizationId: ORG,
      filtro: { ...FILTRO_VAZIO, com_alguma_tag: ["vip"], limite: 50, excluir_contatos: contatos.slice(0, 40) },
      agora: new Date(Date.UTC(2026, 5, 1)),
    });

    expect(lista.map((c) => c.contactId)).toEqual(contatos.slice(40, 90));
    for (const u of banco.urlsDeContatos()) expect(u).not.toContain("not.in");
    cercaDeOrganizacao(banco);
  });

  it("incluídos à mão também vão em lotes (até 5.000 ids), sem URL acima do muro", async () => {
    const contatos = Array.from({ length: 500 }, (_, i) => uuid(i));
    const banco = bancoFalso(contatos, []);

    const { candidatos: lista } = await buscarCandidatos(banco.sb, {
      organizationId: ORG,
      filtro: { ...FILTRO_VAZIO, com_alguma_tag: ["vip"], limite: 50, incluir_contatos: contatos },
      agora: new Date(Date.UTC(2026, 5, 1)),
    });

    // 50 do recorte + os 450 que faltavam, em lotes de 100.
    expect(lista).toHaveLength(500);
    const urls = banco.urlsDeContatos();
    expect(urls.length).toBeGreaterThanOrEqual(6);
    for (const u of urls) expect(u.length).toBeLessThan(MURO_DO_GATEWAY);
    cercaDeOrganizacao(banco);
  });

  it("incluído repetido em lotes diferentes entra UMA vez", async () => {
    const contatos = Array.from({ length: 300 }, (_, i) => uuid(i));
    const banco = bancoFalso(contatos, []);
    // 150 ids fora do recorte; o da posição 120 repete o da posição 10, e os
    // dois caem em lotes diferentes de 100.
    const incluir = contatos.slice(100, 250);
    incluir[120] = incluir[10]!;

    const { candidatos: lista } = await buscarCandidatos(banco.sb, {
      organizationId: ORG,
      filtro: { ...FILTRO_VAZIO, com_alguma_tag: ["vip"], limite: 1, incluir_contatos: incluir },
      agora: new Date(Date.UTC(2026, 5, 1)),
    });

    const ids = lista.map((c) => c.contactId);
    expect(ids.filter((id) => id === incluir[10])).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(1 + 149);
    cercaDeOrganizacao(banco);
  });

  it("a ordem global é a do Postgres: segundo exato antes do fracionário do mesmo segundo", async () => {
    // `localeCompare` (colação ICU) põe `.` antes de `+` e invertia este par. Os
    // dois ficam em lotes diferentes, para que só a ordenação global decida.
    const contatos = Array.from({ length: 150 }, (_, i) => uuid(i));
    const criados: Record<string, string> = {};
    contatos.forEach((c, i) => {
      criados[c] = quando(100_000 + i);
    });
    criados[contatos[5]!] = "2026-01-01T12:34:56.5+00:00";
    criados[contatos[120]!] = "2026-01-01T12:34:56+00:00";
    const negocios = contatos.map((c, i) => ({
      id: uuid(i, "2222"),
      contact_id: c,
      created_at: quando(i),
      custom_fields: {},
    }));
    const banco = bancoFalso(contatos, negocios, criados);

    const { candidatos: lista } = await buscarCandidatos(banco.sb, {
      organizationId: ORG,
      filtro: comFunil({ limite: 1 }),
      agora: new Date(Date.UTC(2026, 5, 1)),
    });

    expect(lista.map((c) => c.contactId)).toEqual([contatos[120]]);
    cercaDeOrganizacao(banco);
  });
});

describe("keyset: página curta não encerra a leitura (#2404)", () => {
  const comFunil = (extra: Partial<FiltroDeAudiencia>) => ({
    ...FILTRO_VAZIO,
    funis: [uuid(900, "8888")],
    ...extra,
  });

  it("max_rows=500: a consulta de ids de negócio segue até a página VAZIA (1.200 negócios)", async () => {
    const contatos = Array.from({ length: 1200 }, (_, i) => uuid(i));
    // Inserção na ordem REVERSA do `created_at`: sem o `.order(…)` da consulta,
    // cada página vem na ordem de inserção e termina no negócio MAIS VELHO dela;
    // o cursor avança de um em um (500, 499, 498…), os mais velhos ficam de fora
    // e a leitura só para no teto. A guarda de "não avançou" nunca dispara —
    // quem fica vermelho é a contagem de páginas (medido: 43 em vez de 4).
    const negocios = [...contatos].reverse().map((c, k) => ({
      id: uuid(1199 - k, "2222"),
      contact_id: c,
      created_at: quando(1199 - k),
      custom_fields: {},
    }));
    const banco = bancoFalso(contatos, negocios, {}, 500);

    const { candidatos: lista } = await buscarCandidatos(banco.sb, {
      organizationId: ORG,
      filtro: comFunil({ limite: 1200 }),
      agora: new Date(Date.UTC(2026, 5, 1)),
    });

    // 500 + 500 + 200 + a página VAZIA que prova o fim (a curta não prova).
    expect(banco.urlsDeNegocio()).toHaveLength(4);
    expect(lista.map((c) => c.contactId)).toEqual(contatos);
    cercaDeOrganizacao(banco);
  });

  it("max_rows=500: sem recorte de negócio, a leitura de contatos segue até a página VAZIA", async () => {
    const contatos = Array.from({ length: 1200 }, (_, i) => uuid(i));
    // Também em ordem reversa: a ordem da resposta tem de vir do `.order(…)`.
    const contatosRev = [...contatos].reverse();
    const banco = bancoFalso(contatosRev, [], {}, 500);

    const { candidatos: lista } = await buscarCandidatos(banco.sb, {
      organizationId: ORG,
      // O limite fica ACIMA do total de propósito: o laço não pode parar por
      // "já tenho o suficiente" antes de a página vazia provar o fim.
      filtro: { ...FILTRO_VAZIO, com_alguma_tag: ["vip"], limite: 5000 },
      agora: new Date(Date.UTC(2026, 5, 1)),
    });

    expect(banco.urlsDeContatos()).toHaveLength(4);
    expect(lista.map((c) => c.contactId)).toEqual(contatosRev);
    cercaDeOrganizacao(banco);
  });

  it("max_rows=500: 1.200 contatos com o MESMO created_at são lidos uma vez cada", async () => {
    // Todo mundo importado no mesmo instante. Só o ramo `and(created_at.eq.…,
    // id.gt.…)` do keyset desempata: sem ele a segunda página pede
    // `created_at > X`, volta vazia, e 700 contatos somem sem erro nenhum.
    const contatos = Array.from({ length: 1200 }, (_, i) => uuid(i));
    const criados = Object.fromEntries(contatos.map((c) => [c, quando(0)]));
    const banco = bancoFalso([...contatos].reverse(), [], criados, 500);

    const { candidatos: lista } = await buscarCandidatos(banco.sb, {
      organizationId: ORG,
      filtro: { ...FILTRO_VAZIO, com_alguma_tag: ["vip"], limite: 5000 },
      agora: new Date(Date.UTC(2026, 5, 1)),
    });

    const ids = lista.map((c) => c.contactId);
    expect(new Set(ids).size, "algum contato foi lido duas vezes").toBe(ids.length);
    expect(ids, "algum contato ficou de fora").toEqual(contatos);
    expect(banco.urlsDeContatos()).toHaveLength(4);
    cercaDeOrganizacao(banco);
  });

  it("max_rows=500: o negócio antigo do contato B não fica de fora da leitura de {{lead.x}}", async () => {
    // A tem 600 negócios recentes; o único de B é mais antigo que todos. Com a
    // leitura parando na primeira página curta (500), B ficava sem negócio — e
    // saía da campanha com `variavel_ausente`.
    const [a, b] = [uuid(1), uuid(2)];
    const negocios: Negocio[] = Array.from({ length: 600 }, (_, i) => ({
      id: uuid(i, "3333"),
      contact_id: a,
      created_at: quando(10_000 + i),
      custom_fields: { gancho: `a ${i}` },
    }));
    negocios.push({
      id: uuid(1, "4444"),
      contact_id: b,
      created_at: quando(5),
      custom_fields: { gancho: "b antigo" },
    });
    const banco = bancoFalso([a, b], negocios, {}, 500);

    const { candidatos: lista } = await buscarCandidatos(banco.sb, {
      organizationId: ORG,
      filtro: { ...FILTRO_VAZIO, com_alguma_tag: ["vip"], limite: 2 },
      agora: new Date(Date.UTC(2026, 5, 1)),
      corpo: "Oi {{nome}}, {{lead.gancho}}",
    });

    expect(lista.find((c) => c.contactId === a)?.lead?.gancho).toBe("a 599");
    expect(lista.find((c) => c.contactId === b)?.lead?.gancho).toBe("b antigo");
    cercaDeOrganizacao(banco);
  });
});

describe("teto de 20.000 e o aviso de truncamento (#2404)", () => {
  const comFunil = (extra: Partial<FiltroDeAudiencia>) => ({
    ...FILTRO_VAZIO,
    funis: [uuid(900, "8888")],
    ...extra,
  });
  const cemContatos = () => Array.from({ length: 100 }, (_, i) => uuid(i));
  const negociosEmLinha = (quantos: number, contatos: string[]): Negocio[] =>
    Array.from({ length: quantos }, (_, i) => ({
      id: uuid(i, "2020"),
      contact_id: contatos[i % contatos.length]!,
      created_at: quando(i),
      custom_fields: {},
    }));

  it("1.200 linhas: abaixo do teto, NÃO marca truncado", async () => {
    const contatos = cemContatos();
    const banco = bancoFalso(contatos, negociosEmLinha(1200, contatos));

    const { candidatos: lista, truncado } = await buscarCandidatos(banco.sb, {
      organizationId: ORG,
      filtro: comFunil({ limite: 5000 }),
      agora: new Date(Date.UTC(2026, 5, 1)),
    });

    // 1000 + 200 + a página vazia; sem sonda além do teto.
    expect(banco.urlsDeNegocio()).toHaveLength(3);
    expect(truncado).toBe(false);
    expect(lista).toHaveLength(100);
    cercaDeOrganizacao(banco);
  });

  it("20.001 linhas: corta no teto, sonda UMA a mais e marca truncado", async () => {
    const contatos = cemContatos();
    const banco = bancoFalso(contatos, negociosEmLinha(20_001, contatos));

    const { candidatos: lista, truncado } = await buscarCandidatos(banco.sb, {
      organizationId: ORG,
      filtro: comFunil({ limite: 5000 }),
      agora: new Date(Date.UTC(2026, 5, 1)),
    });

    // 20 páginas cheias + a sonda da linha 20.001.
    expect(banco.urlsDeNegocio(), "não parou no teto ou não sondou").toHaveLength(21);
    expect(truncado).toBe(true);
    expect(lista).toHaveLength(100);
    cercaDeOrganizacao(banco);
  });

  it("exatamente 20.000 linhas: bate o teto mas a sonda volta vazia — NÃO marca", async () => {
    const contatos = cemContatos();
    const banco = bancoFalso(contatos, negociosEmLinha(20_000, contatos));

    const { truncado } = await buscarCandidatos(banco.sb, {
      organizationId: ORG,
      filtro: comFunil({ limite: 5000 }),
      agora: new Date(Date.UTC(2026, 5, 1)),
    });

    expect(banco.urlsDeNegocio()).toHaveLength(21);
    expect(truncado).toBe(false);
    cercaDeOrganizacao(banco);
  });
});

describe("#2402: funil com 2.500 negócios e max_rows=1.000", () => {
  const comFunil = (extra: Partial<FiltroDeAudiencia>) => ({
    ...FILTRO_VAZIO,
    funis: [uuid(900, "8888")],
    ...extra,
  });
  /** Um negócio por contato, do mais novo ao mais velho, na ordem da lista. */
  const negociosDe = (contatos: string[]): Negocio[] =>
    contatos.map((c, i) => ({
      id: uuid(i, "2222"),
      contact_id: c,
      created_at: quando(i),
      custom_fields: {},
    }));

  it("2.500 contatos distintos: a audiência sai INTEIRA, não 1.000", async () => {
    // O defeito da #2402: `.limit(20_000)` sem paginação devolve só o primeiro
    // `max_rows` de linhas — 1.000 — e a preparação segue sem erro nenhum.
    const contatos = Array.from({ length: 2500 }, (_, i) => uuid(i));
    const banco = bancoFalso(contatos, negociosDe(contatos)); // max_rows = 1.000

    const { candidatos: lista, truncado } = await buscarCandidatos(banco.sb, {
      organizationId: ORG,
      filtro: comFunil({ limite: 5000 }),
      agora: new Date(Date.UTC(2026, 5, 1)),
    });

    expect(lista.map((c) => c.contactId)).toEqual(contatos);
    expect(truncado).toBe(false);
    // 3 páginas cheias (1000 + 1000 + 500) + a página VAZIA que prova o fim.
    expect(banco.urlsDeNegocio()).toHaveLength(4);
    cercaDeOrganizacao(banco);
  });

  it("900 negócios: abaixo do max_rows, uma página só — o comportamento não muda", async () => {
    const contatos = Array.from({ length: 900 }, (_, i) => uuid(i));
    const banco = bancoFalso(contatos, negociosDe(contatos));

    const { candidatos: lista, truncado } = await buscarCandidatos(banco.sb, {
      organizationId: ORG,
      filtro: comFunil({ limite: 5000 }),
      agora: new Date(Date.UTC(2026, 5, 1)),
    });

    expect(lista.map((c) => c.contactId)).toEqual(contatos);
    expect(truncado).toBe(false);
    expect(banco.urlsDeNegocio()).toHaveLength(2);
  });
});
