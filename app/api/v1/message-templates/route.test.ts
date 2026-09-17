/**
 * POST /api/v1/message-templates — idempotência do caminho de criação.
 *
 * O que estes casos provam, e por que nesta forma:
 *
 * 1. Duas requisições idênticas (mesma chave, mesmo corpo) criam **um**
 *    template. A asserção é na CONTAGEM de inserts, não só na resposta: um
 *    caminho que devolvesse a resposta gravada e inserisse de novo passaria
 *    numa asserção de igualdade de corpo e ainda assim duplicaria dado.
 * 2. Mesma chave com corpo diferente devolve 409 `idempotency_conflict` — o
 *    código que o contrato (spec 01 §7.3) e o mapa de erros do frontend
 *    (`docs/specs/09` §8) já esperam.
 * 3. Sem a chave, o comportamento é o de antes: cria e não grava recibo. É o
 *    caso que impede o conserto degenerado de "exigir chave sempre", que
 *    quebraria todo chamador atual.
 * 4. Chave malformada é recusada antes de qualquer efeito, e sem recibo.
 *
 * O helper é exercitado de verdade (não é mockado): o que se testa é a
 * integração entre a rota e ele.
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

import { POST } from "@/app/api/v1/message-templates/route";

const ORG = "b7c30000-0000-4000-8000-000000000001";
const USER = "b7c30000-0000-4000-8000-000000000002";
const CHAVE = "b7c30000-0000-4000-8000-000000000003";

type Linha = Record<string, unknown>;

/** Fake stateful das duas tabelas que a rota toca. */
function banco() {
  const templates: Linha[] = [];
  const recibos: Linha[] = [];
  let seq = 0;

  h.from.mockImplementation((tabela: string) => {
    if (tabela === "message_templates") {
      return {
        insert: (linha: Linha) => ({
          select: () => ({
            single: async () => {
              const criado = { id: `tpl-${++seq}`, ...linha };
              templates.push(criado);
              return { data: criado, error: null };
            },
          }),
        }),
      };
    }
    // idempotency_keys — a mesma cadeia que o helper usa.
    let filtros: Array<[string, unknown]> = [];
    let maiorQue: [string, unknown] | null = null;
    const builder = {
      select: () => builder,
      eq: (coluna: string, valor: unknown) => {
        filtros.push([coluna, valor]);
        return builder;
      },
      gt: (coluna: string, valor: unknown) => {
        maiorQue = [coluna, valor];
        return builder;
      },
      maybeSingle: async () => ({
        data:
          recibos.find(
            (r) =>
              filtros.every(([c, v]) => r[c] === v) &&
              (maiorQue ? String(r[maiorQue[0]]) > String(maiorQue[1]) : true),
          ) ?? null,
        error: null,
      }),
      insert: async (linha: Linha) => {
        recibos.push(linha);
        filtros = [];
        maiorQue = null;
        return { error: null };
      },
    };
    return builder;
  });

  return { templates, recibos };
}

function req(corpo: unknown, chave?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (chave) headers["Idempotency-Key"] = chave;
  return new NextRequest("http://localhost/api/v1/message-templates", {
    method: "POST",
    headers,
    body: JSON.stringify(corpo),
  });
}

const CORPO = { title: "Boas-vindas", body: "Olá! Como podemos ajudar?" };

beforeEach(() => {
  vi.resetAllMocks();
  h.guard.mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt" },
    org: { orgId: ORG, role: "agent" },
  });
  h.apoio.mockResolvedValue(null);
});

describe("POST /api/v1/message-templates — idempotência", () => {
  it("(1) mesma chave e mesmo corpo: cria UM template e responde igual das duas vezes", async () => {
    const db = banco();

    const primeira = await POST(req(CORPO, CHAVE));
    const segunda = await POST(req(CORPO, CHAVE));

    expect(primeira.status).toBe(201);
    expect(segunda.status).toBe(201);
    expect(db.templates).toHaveLength(1);
    expect((await primeira.json()).data.id).toBe((await segunda.json()).data.id);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(db.recibos).toHaveLength(1);
  });

  it("(2) mesma chave e corpo diferente: 409 idempotency_conflict, sem criar de novo", async () => {
    const db = banco();

    await POST(req(CORPO, CHAVE));
    const conflito = await POST(req({ ...CORPO, title: "Outro assunto" }, CHAVE));

    expect(conflito.status).toBe(409);
    expect((await conflito.json()).error.code).toBe("idempotency_conflict");
    expect(db.templates).toHaveLength(1);
    expect(db.recibos).toHaveLength(1);
  });

  it("(3) sem a chave: comportamento de antes — cria e não grava recibo", async () => {
    const db = banco();

    const resposta = await POST(req(CORPO));

    expect(resposta.status).toBe(201);
    expect(db.templates).toHaveLength(1);
    expect(db.recibos).toHaveLength(0);
  });

  it("(4) chave que não é UUID: 400 antes de qualquer efeito, e sem recibo", async () => {
    const db = banco();

    const resposta = await POST(req(CORPO, "nao-e-uuid"));

    expect(resposta.status).toBe(400);
    expect(db.templates).toHaveLength(0);
    expect(db.recibos).toHaveLength(0);
  });
});
