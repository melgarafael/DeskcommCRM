/**
 * GET /api/v1/admin/tenants/export — o inventário das instalações em CSV
 * (issue #2777), com os MESMOS filtros da listagem e sem levar para o arquivo
 * o que a anonimização jurou apagar.
 *
 * ─── O que este arquivo mede ───────────────────────────────────────────────
 *
 * 1. o envelope: BOM UTF-8 nos três primeiros bytes, `Content-Type` próprio e
 *    `Content-Disposition: attachment; filename=tenants-YYYY-MM-DD.csv` — o
 *    mesmo formato do export de auditoria, para a plataforma não ter dois;
 * 2. a equivalência: exportar com `?q=`/`?status=` devolve os MESMOS `id`s, na
 *    MESMA ordem, que a rota de listagem devolve com a mesma query. Os DOIS
 *    handlers rodam aqui contra o mesmo dublê de banco, então divergência de
 *    filtro ou de ordenação reprova o caso;
 * 3. o centro do pedido: a linha de um tenant `status=redacted` não contém o
 *    `display_name`, o `legal_name` nem o `cnpj` ORIGINAIS. O worker de LGPD
 *    só vira o `status` da organização (`workers/lgpd-redact-worker.ts`) — a
 *    tabela guarda os valores de antes —, então quem exporta é quem decide se
 *    entrega exatamente o dado que a anonimização prometeu ter apagado;
 * 4. o teto com `X-Export-Truncado`, a auditoria `platform.tenants_exported`
 *    e a recusa de quem não é platform admin.
 *
 * O dublê aplica os filtros DE VERDADE: apagar o `.or()` do `q` ou a troca de
 * `status === "onboarding"` muda o resultado de algum caso abaixo.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";

import { GET as exportar } from "./route";
import { GET as listar } from "../route";

vi.mock("@/lib/auth/requirePlatformAdmin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/requirePlatformAdmin")>()),
  requirePlatformAdmin: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const USER = "11111111-1111-4111-8111-111111111111";
const URL_BASE = "http://localhost/api/v1/admin/tenants/export";

/** Mesmo teto do export de auditoria — declarado AQUI, não importado da rota. */
const TETO_DO_EXPORT = 10_000;
const CABECALHO =
  "id,slug,display_name,legal_name,cnpj,status,onboarded_at,suspended_at,created_at,user_count,conversations_count";

type Linha = Record<string, unknown>;
type Predicado = (linha: Linha) => boolean;

/** Separa os termos de um `.or()` do PostgREST respeitando os parênteses. */
function termos(expressao: string): string[] {
  const partes: string[] = [];
  let atual = "";
  let profundidade = 0;
  for (const caractere of expressao) {
    if (caractere === "(") profundidade += 1;
    if (caractere === ")") profundidade -= 1;
    if (caractere === "," && profundidade === 0) {
      partes.push(atual);
      atual = "";
      continue;
    }
    atual += caractere;
  }
  if (atual !== "") partes.push(atual);
  return partes;
}

/** Um termo `coluna::tipo.operador.valor` — o valor pode conter pontos (ISO). */
function casoumTermo(termo: string, linha: Linha): boolean {
  const primeiroPonto = termo.indexOf(".");
  const colunaComTipo = termo.slice(0, primeiroPonto);
  const resto = termo.slice(primeiroPonto + 1);
  const segundoPonto = resto.indexOf(".");
  const operador = resto.slice(0, segundoPonto);
  const valor = resto.slice(segundoPonto + 1);
  const coluna = colunaComTipo.split("::")[0] as string;
  const atual = linha[coluna];
  switch (operador) {
    case "eq":
      return atual === valor;
    case "lt":
      return String(atual ?? "") < valor;
    case "ilike": {
      const alvo = valor.replace(/^%|%$/g, "").toLowerCase();
      return String(atual ?? "").toLowerCase().includes(alvo);
    }
    default:
      return false;
  }
}

function casaNoOu(expressao: string, linha: Linha): boolean {
  return termos(expressao).some((termo) => {
    if (termo.startsWith("and(") && termo.endsWith(")")) {
      return termos(termo.slice(4, -1)).every((interno) => casoumTermo(interno, linha));
    }
    return casoumTermo(termo, linha);
  });
}

/**
 * Dublê do client de service role: encadeia, filtra, ORDENA por todas as chaves
 * pedidas e impõe o `.limit()` DEPOIS dos predicados — como o PostgREST, onde a
 * ordem das chamadas não decide a ordem de execução.
 */
function dubleAdmin(tabelas: Record<string, Linha[]>) {
  function consulta(
    tabela: string,
    predicados: Predicado[] = [],
    ordens: { coluna: string; ascendente: boolean }[] = [],
    limite?: number,
  ) {
    const linhas = (): Linha[] => {
      const filtradas = (tabelas[tabela] ?? []).filter((l) => predicados.every((p) => p(l)));
      const ordenadas = [...filtradas].sort((a, b) => {
        for (const { coluna, ascendente } of ordens) {
          const esquerda = String(a[coluna] ?? "");
          const direita = String(b[coluna] ?? "");
          if (esquerda === direita) continue;
          const cmp = esquerda < direita ? -1 : 1;
          return ascendente ? cmp : -cmp;
        }
        return 0;
      });
      return limite === undefined ? ordenadas : ordenadas.slice(0, limite);
    };
    const api: Record<string, unknown> = {
      select: () => consulta(tabela, predicados, ordens, limite),
      eq: (coluna: string, valor: unknown) =>
        consulta(tabela, [...predicados, (l) => l[coluna] === valor], ordens, limite),
      is: (coluna: string, valor: unknown) =>
        consulta(tabela, [...predicados, (l) => l[coluna] === valor], ordens, limite),
      or: (expressao: string) =>
        consulta(tabela, [...predicados, (l) => casaNoOu(expressao, l)], ordens, limite),
      limit: (n: number) => consulta(tabela, predicados, ordens, n),
      order: (coluna: string, opcoes?: { ascending?: boolean }) =>
        consulta(tabela, predicados, [...ordens, { coluna, ascendente: opcoes?.ascending !== false }], limite),
      then: (resolver: (r: { data: Linha[]; error: null }) => unknown) =>
        resolver({ data: linhas(), error: null }),
    };
    return api;
  }
  return { from: (tabela: string) => consulta(tabela) };
}

function tenant(indice: number, extra: Linha = {}): Linha {
  const n = String(indice).padStart(6, "0");
  return {
    id: `00000000-0000-4000-8000-${n}`,
    slug: `tenant-${n}`,
    display_name: `Loja ${n}`,
    legal_name: `Comercio ${n} Ltda`,
    cnpj: `11.222.333/0001-${n.slice(-2)}`,
    status: "active",
    onboarded_at: "2026-01-05T00:00:00.000Z",
    suspended_at: null,
    created_at: new Date(Date.UTC(2026, 0, 1) + indice * 1000).toISOString(),
    user_count: [{ count: 3 }],
    conversations_count: [{ count: 7 }],
    ...extra,
  };
}

/** Parser RFC 4180 de verdade: aspas, vírgula e quebra dentro da célula. */
function csvParaMatriz(csv: string): string[][] {
  const texto = csv.replace(/^\uFEFF/, "");
  const matriz: string[][] = [];
  let linha: string[] = [];
  let celula = "";
  let entreAspas = false;
  for (let i = 0; i < texto.length; i += 1) {
    const caractere = texto[i] as string;
    if (entreAspas) {
      if (caractere === '"' && texto[i + 1] === '"') {
        celula += '"';
        i += 1;
      } else if (caractere === '"') {
        entreAspas = false;
      } else {
        celula += caractere;
      }
      continue;
    }
    if (caractere === '"') {
      entreAspas = true;
      continue;
    }
    if (caractere === ",") {
      linha.push(celula);
      celula = "";
      continue;
    }
    if (caractere === "\n") {
      linha.push(celula);
      matriz.push(linha);
      linha = [];
      celula = "";
      continue;
    }
    if (caractere === "\r") continue;
    celula += caractere;
  }
  if (celula !== "" || linha.length > 0) {
    linha.push(celula);
    matriz.push(linha);
  }
  return matriz;
}

function montar(linhas: Linha[]): void {
  vi.mocked(createAdminClient).mockReturnValue(dubleAdmin({ organizations: linhas }) as never);
}

function chamarExport(url = ""): Promise<Response> {
  return exportar(new NextRequest(`${URL_BASE}${url}`));
}

function chamarListagem(url: string): Promise<Response> {
  return listar(new NextRequest(`http://localhost/api/v1/admin/tenants${url}`));
}

beforeEach(() => {
  vi.mocked(requirePlatformAdmin).mockReset();
  vi.mocked(requirePlatformAdmin).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(audit).mockClear();
  vi.mocked(createAdminClient).mockReset();
  montar([tenant(1), tenant(2)]);
});

describe("o envelope", () => {
  it("⭐ sai com BOM UTF-8, Content-Type próprio e attachment datado", async () => {
    const res = await chamarExport();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="tenants-${new Date().toISOString().slice(0, 10)}.csv"`,
    );

    // O BOM são os TRÊS primeiros bytes: `res.text()` o come, então quem
    // prova é o binário — como o navegador de download enxerga o arquivo.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("⭐ as 11 colunas da AdminTenantRow, nesta ordem e nenhuma a mais", async () => {
    const csv = await (await chamarExport()).text();

    expect(csvParaMatriz(csv)[0]).toEqual(CABECALHO.split(","));
  });

  it("a contagem sai como NÚMERO SIMPLES, não como o array {count} da leitura", async () => {
    const csv = await (await chamarExport()).text();
    const dados = csvParaMatriz(csv).slice(1);

    expect(dados[0]?.[9]).toBe("3");
    expect(dados[0]?.[10]).toBe("7");
    // Nem o objeto `{count}` da leitura nem a chave `count` chegam ao arquivo.
    expect(dados.flat().join(",")).not.toContain("count");
    expect(dados.flat().join(",")).not.toContain("{");
  });

  it("formato que não é csv é 422 com a frase que ensina o certo", async () => {
    const res = await chamarExport("?formato=xlsx");

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.message).toContain("?formato=csv");
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("a mesma lista da rota de leitura", () => {
  it("⭐ sem filtro nenhum devolve os mesmos tenants, na mesma ordem", async () => {
    const idsDaListagem = ((await (await chamarListagem("?limit=100")).json()) as {
      data: { id: string }[];
    }).data.map((t) => t.id);
    const csv = await (await chamarExport()).text();
    const idsDoArquivo = csvParaMatriz(csv).slice(1).map((linha) => linha[0]);

    expect(idsDaListagem).toHaveLength(2);
    expect(idsDoArquivo).toEqual(idsDaListagem);
  });

  it("⭐ `?q=` e `?status=` viajam inteiros: os mesmos filtros, o mesmo resultado", async () => {
    montar([
      tenant(1),
      tenant(2, { display_name: "Acme Distribuidora", slug: "acme-distribuidora" }),
      tenant(3, { status: "suspended" }),
      tenant(4, { status: "redacted" }),
      tenant(5, { status: "active", display_name: "Acme Varejo", onboarded_at: null }),
    ]);

    for (const url of ["?q=acme&status=active", "?status=suspended", "?status=onboarding", "?q=000003"]) {
      const daListagem = ((await (await chamarListagem(`${url}&limit=100`)).json()) as {
        data: { id: string }[];
      }).data.map((t) => t.id);
      const csv = await (await chamarExport(url)).text();
      const doArquivo = csvParaMatriz(csv).slice(1).map((linha) => linha[0]);

      expect(doArquivo, `filtro ${url}`).toEqual(daListagem);
    }
  });

  it("o filtro `status=onboarding` é o estado derivado, como na listagem", async () => {
    montar([tenant(1), tenant(2, { onboarded_at: null })]);

    const csv = await (await chamarExport("?status=onboarding")).text();

    expect(csvParaMatriz(csv).slice(1).map((l) => l[0])).toEqual([tenant(2).id]);
  });
});

describe("⭐ o tenant redacted não entrega o que a anonimização apagou", () => {
  const ORIGINAL = {
    display_name: "Loja do João",
    legal_name: "João Comércio e Participações Ltda",
    cnpj: "12.345.678/0001-90",
  };

  it("a linha não contém display_name, legal_name nem cnpj originais", async () => {
    montar([
      tenant(1, { status: "redacted", ...ORIGINAL }),
      tenant(2, { status: "active", ...ORIGINAL }),
    ]);

    const csv = await (await chamarExport()).text();
    const linhas = csvParaMatriz(csv).slice(1);
    const redigida = linhas.find((l) => l[5] === "redacted") as string[];
    const viva = linhas.find((l) => l[5] === "active") as string[];

    // Controle: o arquivo SABE o que é nome de empresa — a linha ativa traz os
    // três valores. Sem isto o caso passaria porque o CSV não os tinha mesmo.
    expect(viva.slice(2, 5)).toEqual([ORIGINAL.display_name, ORIGINAL.legal_name, ORIGINAL.cnpj]);
    for (const valor of Object.values(ORIGINAL)) {
      expect(redigida.join(","), `${valor} vazou na linha redigida`).not.toContain(valor);
    }
    // O inventário continua legível: id e slug são identificador técnico.
    expect(redigida[0]).toBe(tenant(1).id);
    expect(redigida[1]).toBe(tenant(1).slug);
    expect(redigida[5]).toBe("redacted");
  });

  it("o que SAI no lugar é o marcador de redação de lib/lgpd/cascata.ts", async () => {
    const { NOTA_REDIGIDA } = await import("@/lib/lgpd/cascata");
    montar([tenant(1, { status: "redacted", ...ORIGINAL })]);

    const csv = await (await chamarExport()).text();
    const linha = csvParaMatriz(csv)[1] as string[];

    expect(linha[2]).toBe(NOTA_REDIGIDA);
    expect(linha[3]).toBe(NOTA_REDIGIDA);
    // CNPJ não tem forma redigida: o que não existe mais sai vazio.
    expect(linha[4]).toBe("");
  });

  it("o que a anonimização JÁ redigiu passa intacto — a regra é idempotente", async () => {
    const { SUFIXO_ANONIMIZADO } = await import("@/lib/lgpd/cascata");
    const jaRedigido = `Comercio 000001${SUFIXO_ANONIMIZADO}`;
    montar([tenant(1, { status: "redacted", legal_name: jaRedigido })]);

    const csv = await (await chamarExport()).text();

    expect(csv).toContain(jaRedigido);
  });
});

describe("célula que a planilha leria como fórmula", () => {
  it("⭐ texto do tenant que começa com = ou @ sai com aspa simples na frente; o resto, intacto", async () => {
    montar([
      tenant(1, { status: "active", display_name: "=1+1", legal_name: "@x" }),
      tenant(2, { status: "active", display_name: "Loja Comum", legal_name: "Loja Comum Ltda" }),
    ]);

    const csv = await (await chamarExport()).text();
    const linhas = csvParaMatriz(csv).slice(1);
    const perigosa = linhas.find((l) => l[0] === tenant(1).id) as string[];
    const controle = linhas.find((l) => l[0] === tenant(2).id) as string[];

    expect(perigosa.slice(2, 4)).toEqual(["'=1+1", "'@x"]);
    // Controle: o texto comum não ganha prefixo, e a contagem segue número.
    expect(controle.slice(2, 4)).toEqual(["Loja Comum", "Loja Comum Ltda"]);
    expect(controle[9]).toBe("3");
  });

  it("trecho depois de `;` que começa com fórmula também sai como texto (Excel pt-BR divide por `;`)", async () => {
    montar([tenant(1, { status: "active", display_name: "Loja;=1+1", legal_name: "A;@x;B" })]);

    const csv = await (await chamarExport()).text();
    const linha = csvParaMatriz(csv).slice(1)[0] as string[];

    expect(linha.slice(2, 4)).toEqual(["Loja;'=1+1", "A;'@x;B"]);
  });

  it("trecho depois de quebra de linha ou de vírgula também sai como texto (leitor que não respeita aspas)", async () => {
    montar([tenant(1, { status: "active", display_name: "Loja\n=1+1", legal_name: "A,@x" })]);

    const csv = await (await chamarExport()).text();
    const linha = csvParaMatriz(csv).slice(1)[0] as string[];

    expect(linha.slice(2, 4)).toEqual(["Loja\n'=1+1", "A,'@x"]);
  });
});

describe("o corte", () => {
  it("⭐ passa do teto: corta em 10.000 e avisa com X-Export-Truncado", async () => {
    montar(Array.from({ length: TETO_DO_EXPORT + 1 }, (_, k) => tenant(k + 1)));

    const res = await chamarExport();
    const linhas = csvParaMatriz(await res.text());

    expect(linhas).toHaveLength(TETO_DO_EXPORT + 1); // cabeçalho + 10.000
    expect(res.headers.get("X-Export-Truncado")).toBe("true");
  });

  it("abaixo do teto não há header nenhum", async () => {
    const res = await chamarExport();

    expect(res.headers.get("X-Export-Truncado")).toBeNull();
  });
});

describe("a trilha de auditoria", () => {
  it("⭐ grava platform.tenants_exported com total, corte e filtros", async () => {
    await chamarExport("?status=active");

    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "platform.tenants_exported",
      actorUserId: USER,
      actingAsPlatformAdmin: true,
      bypassedRls: true,
      metadata: { total: 2, truncado: false, filtros: { status: "active", has_q: false } },
    });
  });

  it("nunca grava o TEXTO da busca — só que havia busca", async () => {
    await chamarExport("?q=acme");

    expect(JSON.stringify(vi.mocked(audit).mock.calls[0]![0].metadata)).not.toContain("acme");
  });
});

describe("a porta", () => {
  it("sem requirePlatformAdmin é 403 e o banco nem é tocado", async () => {
    vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error("não é admin"));

    const res = await chamarExport();

    expect(res.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("query inválida é 400 — a mesma validação da listagem", async () => {
    const res = await chamarExport("?limit=999");

    expect(res.status).toBe(400);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
