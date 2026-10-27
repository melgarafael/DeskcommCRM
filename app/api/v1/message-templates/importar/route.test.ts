/**
 * POST /api/v1/message-templates/importar — o recorte aditivo do blueprint
 * (issue #1995).
 *
 * O que estes casos provam, e por que nesta forma:
 *
 * 1. Em organização vazia, aplica TODAS as linhas num insert só, como
 *    compartilhadas (`owner_user_id null`), com mídia vazia e ordem renumerada
 *    pela posição do arquivo — a fração da origem não atravessa.
 * 2. Em organização que já tem resposta compartilhada, responde 409 e NÃO
 *    insere nada. A asserção é na ausência de `insert`, não só no status: uma
 *    rota que recusasse depois de gravar teria o mesmo corpo de erro.
 * 3. O segundo POST do MESMO arquivo cai no mesmo 409 — é a idempotência de
 *    graça do recorte, provada com estado de verdade entre as duas chamadas.
 * 4. Cabeçalho errado (formato/versão/tipo) é recusado ANTES dos itens: o
 *    arquivo da versão 2 não pode receber "item inválido" como motivo.
 * 5. Corpo grande é barrado pelo tamanho antes do parser.
 * 6. O audit registra QUANTAS entraram, nunca o conteúdo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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

import { POST } from "@/app/api/v1/message-templates/importar/route";

const ORG = "c7d40000-0000-4000-8000-000000000011";
const USER = "c7d40000-0000-4000-8000-000000000012";

type Linha = Record<string, unknown>;

/**
 * Banco fake com ESTADO: o `insert` muda o que a contagem seguinte enxerga, que
 * é o que faz o caso do segundo POST ser uma prova de verdade e não um mock
 * combinado.
 */
function banco(inicial: Linha[] = []) {
  const compartilhadas: Linha[] = [...inicial];
  const inserts: Linha[][] = [];

  const contagem = {
    select: () => contagem,
    eq: () => contagem,
    is: () => contagem,
    then<T>(resolve: (valor: unknown) => T) {
      return Promise.resolve({ count: compartilhadas.length, error: null }).then(resolve);
    },
  };

  h.from.mockImplementation((tabela: string) => {
    if (tabela !== "message_templates") throw new Error(`tabela inesperada: ${tabela}`);
    return {
      ...contagem,
      insert: (linhas: Linha[]) => {
        inserts.push(linhas);
        compartilhadas.push(...linhas);
        return Promise.resolve({ error: null });
      },
    };
  });

  return { compartilhadas, inserts };
}

function blueprint(itens: Linha[], cabecalho: Linha = {}) {
  return {
    formato: "deskcomm.blueprint",
    versao: 1,
    tipo: "respostas_rapidas",
    gerado_em: "2026-10-27T12:00:00.000Z",
    itens,
    ...cabecalho,
  };
}

function pedido(corpo: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/message-templates/importar", {
    method: "POST",
    body: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.guard.mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  });
  h.apoio.mockResolvedValue(null);
  h.audit.mockResolvedValue(undefined);
});

describe("POST /message-templates/importar", () => {
  it("aplica em organização vazia como compartilhadas, com mídia vazia e ordem do arquivo", async () => {
    const db = banco();

    const res = await POST(
      pedido(
        blueprint([
          { titulo: "Boas-vindas", corpo: "Olá!", atalho: "bv", mostrar_na_barra: true },
          // `ordem` forjada no arquivo é ignorada: quem manda é a posição.
          { titulo: "Preço", corpo: "R$ ...", ordem: 137.5 },
        ]),
      ),
    );

    expect(res.status).toBe(201);
    expect((await res.json()).data).toEqual({ importadas: 2, midias_importadas: 0 });

    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toEqual([
      {
        organization_id: ORG,
        owner_user_id: null,
        title: "Boas-vindas",
        body: "Olá!",
        shortcut: "bv",
        mostrar_na_barra: true,
        ordem: 0,
        midias: [],
      },
      {
        organization_id: ORG,
        owner_user_id: null,
        title: "Preço",
        body: "R$ ...",
        shortcut: null,
        mostrar_na_barra: true,
        ordem: 1,
        midias: [],
      },
    ]);
  });

  it("organização que já tem compartilhada recusa com 409 e não insere", async () => {
    const db = banco([
      { organization_id: ORG, owner_user_id: null, title: "Já existe", body: "", shortcut: null },
    ]);

    const res = await POST(pedido(blueprint([{ titulo: "Nova", corpo: "x" }])));

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("state_conflict");
    expect(db.inserts).toHaveLength(0);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("o segundo POST do mesmo arquivo recusa: import não reaplica nem duplica", async () => {
    const db = banco();
    const arquivo = blueprint([
      { titulo: "Uma", corpo: "a" },
      { titulo: "Duas", corpo: "b" },
    ]);

    const primeira = await POST(pedido(arquivo));
    const segunda = await POST(pedido(arquivo));

    expect(primeira.status).toBe(201);
    expect(segunda.status).toBe(409);
    // Duas linhas no banco, um insert: nada foi duplicado nem sobrescrito.
    expect(db.compartilhadas).toHaveLength(2);
    expect(db.inserts).toHaveLength(1);
  });

  it("arquivo de outra versão diz a versão, e não 'item inválido'", async () => {
    const db = banco();

    const res = await POST(pedido(blueprint([{ titulo: "x", corpo: "y" }], { versao: 2 })));

    expect(res.status).toBe(422);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("validation_failed");
    expect(corpo.error.message).toMatch(/versão/);
    expect(db.inserts).toHaveLength(0);
  });

  it("arquivo que não é blueprint e blueprint de outro tipo são recusados", async () => {
    const db = banco();

    const naoEhBlueprint = await POST(pedido({ itens: [{ titulo: "x" }] }));
    expect(naoEhBlueprint.status).toBe(422);
    expect((await naoEhBlueprint.json()).error.message).toMatch(/não é um blueprint/);

    const outroTipo = await POST(pedido(blueprint([{ titulo: "x" }], { tipo: "funis_e_etapas" })));
    expect(outroTipo.status).toBe(422);
    expect((await outroTipo.json()).error.message).toMatch(/não é de respostas rápidas/);

    expect(db.inserts).toHaveLength(0);
  });

  it("item fora dos limites do POST é recusado sem inserir nada", async () => {
    const db = banco();

    const res = await POST(pedido(blueprint([{ titulo: "t".repeat(81), corpo: "x" }])));

    expect(res.status).toBe(422);
    expect(db.inserts).toHaveLength(0);
  });

  it("lista vazia não é blueprint: nada a aplicar", async () => {
    const db = banco();

    const res = await POST(pedido(blueprint([])));

    expect(res.status).toBe(422);
    expect(db.inserts).toHaveLength(0);
  });

  it("corpo que não é JSON é 400 e arquivo grande é 413", async () => {
    const db = banco();

    const invalido = await POST(pedido("isto não é json"));
    expect(invalido.status).toBe(400);
    expect((await invalido.json()).error.code).toBe("invalid_request");

    const grande = await POST(pedido(" ".repeat(2 * 1024 * 1024 + 1)));
    expect(grande.status).toBe(413);
    expect((await grande.json()).error.code).toBe("payload_too_large");

    expect(db.inserts).toHaveLength(0);
  });

  it("a guarda de apoio barra antes de qualquer leitura do banco", async () => {
    h.apoio.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "forbidden_scope" } }), { status: 403 }),
    );

    const res = await POST(pedido(blueprint([{ titulo: "x" }])));

    expect(res.status).toBe(403);
    expect(h.from).not.toHaveBeenCalled();
  });

  it("o audit conta o que entrou, sem guardar conteúdo", async () => {
    banco();

    await POST(pedido(blueprint([{ titulo: "Script interno", corpo: "texto sensível" }])));

    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "template.imported",
        organizationId: ORG,
        metadata: expect.objectContaining({ total: 1, midias_importadas: 0 }),
      }),
    );
    const registrado = JSON.stringify(h.audit.mock.calls[0]?.[0]);
    expect(registrado).not.toContain("Script interno");
    expect(registrado).not.toContain("texto sensível");
  });
});
