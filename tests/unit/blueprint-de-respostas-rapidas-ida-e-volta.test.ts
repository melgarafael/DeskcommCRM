/**
 * O ROUND-TRIP do blueprint de respostas rápidas (issue #1995): exporta de uma
 * organização, importa em outra, e a segunda passa a mostrar a MESMA operação.
 *
 * ─── Por que nas ROTAS, e não só na função pura ─────────────────────────────
 *
 * Serializar e desserializar em memória provaria só que o `JSON.stringify` do
 * Node funciona. O que se quer provar é o caminho inteiro — o que a rota de
 * export LÊ (só as compartilhadas, na ordem da tela, sem mídia), o arquivo que
 * ela escreve, o que a rota de import valida e GRAVA, e o que a organização de
 * destino passa a listar. O banco é fake e com estado; as duas rotas são as de
 * verdade.
 *
 * ─── O que "comportamento igual" significa aqui ─────────────────────────────
 *
 * Ordem, texto, atalho, o "mostrar na barra" e o caráter COMPARTILHADO
 * (`owner_user_id null`). Não se compara id — é da origem, e o destino tem os
 * seus —, nem carimbo de criação, nem mídia: a imagem não atravessa o arquivo
 * (o caminho no bucket é da organização de origem), e o teste diz isso em vez de
 * fingir que atravessou.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  apoio: vi.fn(),
  audit: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.guard }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.apoio }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: h.from }) }));

import { GET as exportar } from "@/app/api/v1/message-templates/exportar/route";
import { POST as importar } from "@/app/api/v1/message-templates/importar/route";

const ORIGEM = "d8e50000-0000-4000-8000-000000000001";
const DESTINO = "d8e50000-0000-4000-8000-000000000002";
const USER = "d8e50000-0000-4000-8000-000000000003";

type Linha = Record<string, unknown>;

/** O banco fake: uma tabela, com filtros e ordem de verdade. */
function banco() {
  const linhas: Linha[] = [];
  let seq = 0;

  type Filtro = { coluna: string; valor: unknown };

  function select(_cols: string, opcoes?: { count?: string; head?: boolean }) {
    const filtros: Filtro[] = [];
    const ordens: { coluna: string; desc: boolean }[] = [];

    const resolver = () => {
      let casadas = linhas.filter((linha) => filtros.every((f) => linha[f.coluna] === f.valor));
      casadas = [...casadas].sort((a, b) => {
        for (const ordem of ordens) {
          const da = a[ordem.coluna];
          const db = b[ordem.coluna];
          if (da === db) continue;
          const comparacao = String(da) < String(db) ? -1 : 1;
          return ordem.desc ? -comparacao : comparacao;
        }
        return 0;
      });
      if (opcoes?.head) return { count: casadas.length, error: null };
      return { data: casadas, error: null };
    };

    const q = {
      eq(coluna: string, valor: unknown) {
        filtros.push({ coluna, valor });
        return q;
      },
      is(coluna: string, valor: unknown) {
        filtros.push({ coluna, valor });
        return q;
      },
      order(coluna: string, opcoesDaOrdem?: { ascending?: boolean }) {
        ordens.push({ coluna, desc: opcoesDaOrdem?.ascending === false });
        return q;
      },
      then<T>(resolve: (valor: unknown) => T) {
        return Promise.resolve(resolver()).then(resolve);
      },
    };
    return q;
  }

  h.from.mockImplementation((tabela: string) => {
    if (tabela !== "message_templates") throw new Error(`tabela inesperada: ${tabela}`);
    return {
      select,
      insert: (novas: Linha[]) => {
        for (const nova of novas) {
          linhas.push({
            id: `tpl-${++seq}`,
            midias: [],
            updated_at: `2026-10-27T12:00:0${seq}.000Z`,
            ...nova,
          });
        }
        return Promise.resolve({ error: null });
      },
    };
  });

  return { linhas };
}

function pedidoDeExport(): NextRequest {
  return new NextRequest("http://localhost/api/v1/message-templates/exportar");
}

function pedidoDeImport(corpo: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/message-templates/importar", {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.apoio.mockResolvedValue(null);
  h.audit.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("blueprint de respostas rápidas: ida e volta", () => {
  it("o que sai da origem é o que o destino passa a listar, na mesma ordem", async () => {
    const { linhas } = banco();

    // A ORIGEM: três compartilhadas e uma pessoal. A ordem gravada não é a de
    // criação (é a que o operador arrastou).
    linhas.push(
      {
        id: "a",
        organization_id: ORIGEM,
        owner_user_id: null,
        title: "Boas-vindas",
        body: "Olá!",
        shortcut: "bv",
        mostrar_na_barra: true,
        ordem: 10,
        midias: [],
        updated_at: "2026-01-01",
      },
      {
        id: "b",
        organization_id: ORIGEM,
        owner_user_id: null,
        title: "Preço",
        body: "R$ 100",
        shortcut: null,
        mostrar_na_barra: false,
        ordem: 20,
        midias: [],
        updated_at: "2026-01-01",
      },
      {
        id: "c",
        organization_id: ORIGEM,
        owner_user_id: null,
        title: "Endereço",
        body: "Rua X",
        shortcut: "end",
        mostrar_na_barra: true,
        ordem: 30,
        midias: [],
        updated_at: "2026-01-01",
      },
      // Pessoal: NÃO sai (não tem dono no destino).
      {
        id: "pessoal",
        organization_id: ORIGEM,
        owner_user_id: USER,
        title: "Meu script",
        body: "particular",
        shortcut: null,
        mostrar_na_barra: true,
        ordem: 5,
        midias: [],
      },
    );

    let orgAtiva = ORIGEM;
    h.guard.mockImplementation(async () => ({
      ok: true,
      user: { id: USER, idioma: "pt-BR" },
      org: { orgId: orgAtiva, role: "manager" },
    }));

    // ── IDA: o arquivo ───────────────────────────────────────────────────────
    const respostaDoExport = await exportar(pedidoDeExport());
    expect(respostaDoExport.status).toBe(200);
    const arquivo = await respostaDoExport.json();
    expect(arquivo.itens.map((item: { titulo: string }) => item.titulo)).toEqual([
      "Boas-vindas",
      "Preço",
      "Endereço",
    ]);

    // ── VOLTA: o destino é outra organização, e está vazia ───────────────────
    orgAtiva = DESTINO;
    const respostaDoImport = await importar(pedidoDeImport(arquivo));
    expect(respostaDoImport.status).toBe(201);
    expect((await respostaDoImport.json()).data.importadas).toBe(3);

    // ── O QUE O DESTINO LISTA ────────────────────────────────────────────────
    const doDestino = linhas.filter((linha) => linha.organization_id === DESTINO);
    expect(doDestino.map((linha) => linha.title)).toEqual(["Boas-vindas", "Preço", "Endereço"]);
    expect(doDestino.map((linha) => linha.body)).toEqual(["Olá!", "R$ 100", "Rua X"]);
    expect(doDestino.map((linha) => linha.shortcut)).toEqual(["bv", null, "end"]);
    expect(doDestino.map((linha) => linha.mostrar_na_barra)).toEqual([true, false, true]);
    // Compartilhadas no destino, como eram na origem.
    expect(doDestino.every((linha) => linha.owner_user_id === null)).toBe(true);
    // Ordem crescente e sem fração herdada.
    expect(doDestino.map((linha) => linha.ordem)).toEqual([0, 1, 2]);
    // Mídia não atravessou: entra vazia, não com o caminho da outra org.
    expect(
      doDestino.every(
        (linha) => Array.isArray(linha.midias) && (linha.midias as unknown[]).length === 0,
      ),
    ).toBe(true);
    // A pessoal da origem ficou na origem.
    expect(doDestino.some((linha) => linha.title === "Meu script")).toBe(false);
  });

  it("reexportar do destino devolve o mesmo arquivo — o par é estável", async () => {
    const { linhas } = banco();
    linhas.push({
      id: "x",
      organization_id: ORIGEM,
      owner_user_id: null,
      title: "Uma",
      body: "corpo",
      shortcut: "um",
      mostrar_na_barra: true,
      ordem: 5,
      midias: [],
      updated_at: "2026-01-01",
    });

    let orgAtiva = ORIGEM;
    h.guard.mockImplementation(async () => ({
      ok: true,
      user: { id: USER, idioma: "pt-BR" },
      org: { orgId: orgAtiva, role: "manager" },
    }));

    const primeiro = await (await exportar(pedidoDeExport())).json();

    orgAtiva = DESTINO;
    await importar(pedidoDeImport(primeiro));

    const segundo = await (await exportar(pedidoDeExport())).json();

    // `gerado_em` muda (é carimbo); o resto é o mesmo arquivo.
    expect({ ...segundo, gerado_em: null }).toEqual({ ...primeiro, gerado_em: null });
  });
});
