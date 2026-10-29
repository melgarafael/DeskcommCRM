/**
 * GET /api/v1/message-templates/exportar — o arquivo de blueprint (issue #1995).
 *
 * O que estes casos provam, e por que nesta forma:
 *
 * 1. O recorte do export é `owner_user_id is null` — a asserção é nos FILTROS da
 *    consulta, não só no corpo: uma rota que devolvesse as pessoais teria o mesmo
 *    envelope e vazaria o script de um vendedor para outra organização.
 * 2. A ordem do arquivo é a ordem que a tela mostra: o array é comparado na
 *    sequência, porque ordem é a informação que mais se perde numa migração.
 * 3. Mídia não viaja — o `storage_path` é da organização de ORIGEM. O que sai do
 *    corpo é a contagem, no header e no audit.
 * 4. Organização sem compartilhada responde 409 e NÃO gera arquivo vazio: um
 *    "importei zero" silencioso é pior que a recusa.
 * 5. O audit registra quantidade — nunca título nem corpo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  audit: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.guard }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: h.from }) }));

import { GET } from "@/app/api/v1/message-templates/exportar/route";

const ORG = "c7d40000-0000-4000-8000-000000000001";
const USER = "c7d40000-0000-4000-8000-000000000002";

type Linha = Record<string, unknown>;

/**
 * A consulta fake: guarda colunas, filtros e ordens e resolve com o resultado
 * dado. `then` é o que faz `await consulta.order(...)` funcionar como no
 * PostgREST.
 */
function consulta(resultado: { data?: unknown; count?: number | null; error?: unknown }) {
  const filtros: Record<string, unknown> = {};
  const ordens: string[] = [];
  let colunas = "";

  const q = {
    select(cols: string) {
      colunas = cols;
      return q;
    },
    eq(coluna: string, valor: unknown) {
      filtros[coluna] = valor;
      return q;
    },
    is(coluna: string, valor: unknown) {
      filtros[coluna] = valor;
      return q;
    },
    order(coluna: string) {
      ordens.push(coluna);
      return q;
    },
    then<T>(resolve: (valor: unknown) => T) {
      return Promise.resolve(resultado).then(resolve);
    },
  };

  return {
    q,
    filtros,
    ordens,
    colunas: () => colunas,
  };
}

function pedido(): NextRequest {
  return new NextRequest("http://localhost/api/v1/message-templates/exportar");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.guard.mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  });
  h.audit.mockResolvedValue(undefined);
});

describe("GET /message-templates/exportar", () => {
  it("lê só as compartilhadas da organização ativa", async () => {
    const c = consulta({ data: [], error: null });
    h.from.mockReturnValue(c.q);

    await GET(pedido());

    expect(h.from).toHaveBeenCalledWith("message_templates");
    expect(c.filtros).toEqual({ organization_id: ORG, owner_user_id: null });
    expect(c.colunas()).toContain("title");
    expect(c.colunas()).toContain("midias");
  });

  it("monta o envelope versionado na ordem da tela", async () => {
    const linhas: Linha[] = [
      {
        title: "Boas-vindas",
        body: "Olá! Como podemos ajudar?",
        shortcut: "bv",
        mostrar_na_barra: true,
        midias: [],
      },
      {
        title: "Preço",
        body: "Nosso valor é...",
        shortcut: null,
        mostrar_na_barra: false,
        midias: [],
      },
    ];
    const c = consulta({ data: linhas, error: null });
    h.from.mockReturnValue(c.q);

    const res = await GET(pedido());
    expect(res.status).toBe(200);

    const corpo = await res.json();
    // O rótulo de formato é CONTRATO do arquivo: ele atravessa instalações, então
    // tem de ser estável e não pode sair da marca desta instalação. Literal aqui
    // de propósito — o teste é a trava contra troca acidental do rótulo.
    expect(corpo.formato).toBe("respostas-rapidas.blueprint");
    expect(corpo.versao).toBe(1);
    expect(corpo.tipo).toBe("respostas_rapidas");
    expect(typeof corpo.gerado_em).toBe("string");
    expect(corpo.itens.map((item: Linha) => item.titulo)).toEqual(["Boas-vindas", "Preço"]);
    // Nada de id, dono ou carimbo da origem dentro do item.
    expect(Object.keys(corpo.itens[0]).sort()).toEqual(
      ["atalho", "corpo", "mostrar_na_barra", "titulo"].sort(),
    );
    // A ordem da lista é a do array; nenhum número de `ordem` da origem vaza.
    expect(c.ordens[0]).toBe("ordem");
  });

  it("a mídia não viaja, e o quanto ficou de fora vai no header e no audit", async () => {
    const linhas: Linha[] = [
      {
        title: "Com foto",
        body: "segue",
        shortcut: "ft",
        mostrar_na_barra: true,
        midias: [
          {
            storage_path: `${ORG}/templates/t1/a.jpg`,
            media_mime: "image/jpeg",
            media_size_bytes: 10,
          },
          {
            storage_path: `${ORG}/templates/t1/b.jpg`,
            media_mime: "image/jpeg",
            media_size_bytes: 20,
          },
        ],
      },
    ];
    const c = consulta({ data: linhas, error: null });
    h.from.mockReturnValue(c.q);

    const res = await GET(pedido());
    expect(res.headers.get("X-Blueprint-Midias-Nao-Exportadas")).toBe("2");

    const texto = await res.text();
    // O caminho do bucket é da organização de origem: não pode aparecer.
    expect(texto).not.toContain("storage_path");
    expect(texto).not.toContain("whatsapp-media");
    expect(JSON.parse(texto).itens[0]).not.toHaveProperty("midias");

    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "template.exported",
        organizationId: ORG,
        metadata: expect.objectContaining({ total: 1, midias_nao_exportadas: 2 }),
      }),
    );
  });

  it("o audit conta o que saiu, sem guardar título nem corpo", async () => {
    const linhas: Linha[] = [
      {
        title: "Script confidencial",
        body: "texto interno",
        shortcut: null,
        mostrar_na_barra: true,
        midias: [],
      },
    ];
    const c = consulta({ data: linhas, error: null });
    h.from.mockReturnValue(c.q);

    await GET(pedido());

    const registrado = JSON.stringify(h.audit.mock.calls[0]?.[0]);
    expect(registrado).not.toContain("Script confidencial");
    expect(registrado).not.toContain("texto interno");
  });

  it("sai como download com o nome do recurso e sem cache", async () => {
    const c = consulta({
      data: [{ title: "a", body: "b", shortcut: null, midias: [] }],
      error: null,
    });
    h.from.mockReturnValue(c.q);

    const res = await GET(pedido());

    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="respostas-rapidas-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("organização sem compartilhada responde 409 e não escreve audit de export", async () => {
    const c = consulta({ data: [], error: null });
    h.from.mockReturnValue(c.q);

    const res = await GET(pedido());

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("state_conflict");
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("propaga a recusa do requireRole sem tocar no banco", async () => {
    h.guard.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), {
        status: 403,
      }),
    });

    const res = await GET(pedido());

    expect(res.status).toBe(403);
    expect(h.from).not.toHaveBeenCalled();
  });
});
