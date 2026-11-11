// @vitest-environment node
/**
 * #3876 (F3) — `color` no PATCH do setor: a GRAVAÇÃO e a RESPOSTA.
 *
 * ─── Por que a resposta é o critério, e não o `update` ─────────────────────
 *
 * A rota grava com `.update({...}).select(SELECT_COLS).maybeSingle()`: o que
 * volta na resposta é o que `SELECT_COLS` projetou. Uma coluna nova que entra no
 * `pdate` e esquece de entrar em `SELECT_COLS` é gravada no banco e volta NULA
 * na resposta — o app mostra o valor antigo, a pessoa salva de novo, e o defeito
 * parece do formulário. Por isso o dublê aqui PROJETA a linha pelas colunas
 * pedidas no `select`: se `color` sair de `SELECT_COLS`, o teste (a) reprova com
 * `undefined` em vez de passar por construção.
 *
 * ─── O 422, e não o 400 ───────────────────────────────────────────────────
 *
 * `validateRequest` (`lib/schemas/_validate.ts`) devolve **422
 * `validation_error`** para qualquer recusa de schema — é a convenção de todas as
 * rotas do repo. Esta fatia não abre exceção: a recusa da cor inválida tem de ser
 * a MESMA das outras validações, senão o cliente passa a ter dois códigos para a
 * mesma coisa.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";
const SETOR = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";

const h = vi.hoisted(() => {
  const estado = {
    // A linha como está no banco ANTES de cada caso.
    linha: {} as Record<string, unknown>,
    /** Os patches que chegaram ao banco — vazio = nada foi gravado. */
    updates: [] as Record<string, unknown>[],
    /** As colunas pedidas no último `select` — é o que a resposta devolve. */
    selects: [] as string[],
    audit: vi.fn(),
    requireRole: vi.fn(),
  };

  /** Dublê mínimo do PostgREST para `update(...).eq().eq().select().maybeSingle()`. */
  function from(_tabela: string) {
    const b: Record<string, unknown> = {
      select: (cols: string) => {
        estado.selects.push(cols);
        return b;
      },
      eq: () => b,
      is: () => b,
      update: (p: Record<string, unknown>) => {
        estado.updates.push(p);
        Object.assign(estado.linha, p);
        return b;
      },
      insert: () => b,
      delete: () => b,
      maybeSingle: async () => {
        const cols = (estado.selects[estado.selects.length - 1] ?? "")
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);
        const projeto: Record<string, unknown> = {};
        for (const coluna of cols) projeto[coluna] = estado.linha[coluna];
        return { data: cols.length ? projeto : estado.linha, error: null };
      },
      single: async () => ({ data: estado.linha, error: null }),
      then: (ok: (r: unknown) => unknown, falha?: (e: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(ok, falha),
    };
    return b;
  }

  return { estado, from };
});

vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: vi.fn(async () => null),
}));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn(async () => true) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({ from: h.from })) }));
// O portão dual abre o cliente de sessão no ramo da sessão; a rota usa o admin.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: h.estado.audit }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.estado.requireRole }));

import { requireSupportWrite } from "@/lib/impersonate/support";
import { fail } from "@/lib/api/wrappers";
import { PATCH } from "@/app/api/v1/attendants/sectors/[id]/route";

const COR_ANTES = "#00655a";
const COR_DEPOIS = "#3e63dd";

function requisicao(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/attendants/sectors/${SETOR}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
const ctx = { params: Promise.resolve({ id: SETOR }) };

beforeEach(() => {
  vi.clearAllMocks();
  h.estado.linha = {
    id: SETOR,
    organization_id: ORG,
    name: "Comercial",
    description: null,
    color: COR_ANTES,
    schedule: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  h.estado.updates = [];
  h.estado.selects = [];
  h.estado.requireRole.mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  });
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
});

describe("#3876 F3 — PATCH da cor da fila", () => {
  it("(a) grava `color` e a RESPOSTA devolve o valor gravado (prova do SELECT_COLS)", async () => {
    const res = await PATCH(requisicao({ color: COR_DEPOIS }), ctx);

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Record<string, unknown> };
    // Sem `color` no SELECT_COLS isto vem `undefined` — o defeito que "parece
    // que não gravou".
    expect(corpo.data.color).toBe(COR_DEPOIS);
    expect(h.estado.updates.at(-1)).toMatchObject({ color: COR_DEPOIS });
  });

  it("(b) cor fora de #rrggbb é recusada pelo Zod e NADA é gravado", async () => {
    // Controle POSITIVO primeiro: sem ele, "recusou" não distingue a régua da
    // cor de um campo desconhecido (`.strict()` recusa `color` inteiro hoje).
    const valido = await PATCH(requisicao({ color: "#00655a" }), ctx);
    expect(valido.status).toBe(200);
    h.estado.updates = [];

    for (const invalido of ["azul", "#abc", "#00655g", "00655a", "#00655aa", 123]) {
      const res = await PATCH(requisicao({ color: invalido }), ctx);
      expect(res.status, `cor ${String(invalido)}`).toBe(422);
    }
    expect(h.estado.updates).toHaveLength(0);
  });

  it("`null` apaga a cor e volta na resposta (é escolha, não silêncio)", async () => {
    const res = await PATCH(requisicao({ color: null }), ctx);
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Record<string, unknown> };
    expect(corpo.data.color).toBeNull();
    expect(h.estado.updates.at(-1)).toMatchObject({ color: null });
  });

  it("a auditoria guarda o DE/PARA da cor, e o de só existe porque a rota leu antes", async () => {
    await PATCH(requisicao({ color: COR_DEPOIS }), ctx);

    expect(h.estado.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "attendant.sector_updated",
        resourceId: SETOR,
        metadata: expect.objectContaining({
          fields_changed: ["color"],
          color_from: COR_ANTES,
          color_to: COR_DEPOIS,
        }),
      }),
    );
  });

  it("(f) modo leitura recusa ANTES do RBAC — nenhum papel é consultado", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(
      fail("forbidden", "Somente leitura.", 403) as never,
    );

    const res = await PATCH(requisicao({ color: COR_DEPOIS }), ctx);

    expect(res.status).toBe(403);
    expect(h.estado.requireRole).not.toHaveBeenCalled();
    expect(h.estado.updates).toHaveLength(0);
  });
});
