import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const SERVICO_ID = "33333333-3333-4333-8333-333333333333";

const SERVICO = {
  id: SERVICO_ID,
  codigo: "SOCIAL",
  nome: "Social media",
  descricao: null,
  preco_cents: 120_000,
  moeda: "BRL",
  ativo: true,
  tipo_servico: "recorrente",
  unidade_cobranca: "mes",
  prazo_dias_uteis: null,
  sinal_tipo: "percentual",
  sinal_percentual: 30,
  sinal_cents: null,
  pai_id: null,
  fotos: [],
  instrucoes_ia: null,
  ia_oferece: true,
  ia_agenda: false,
  revision: 3,
};

const PRODUTO = {
  ...SERVICO,
  id: "44444444-4444-4444-8444-444444444444",
  codigo: "CAMISETA",
  nome: "Camiseta",
  tipo_servico: null,
  unidade_cobranca: null,
  sinal_tipo: null,
  sinal_percentual: null,
};

/**
 * O PATCH DO SERVIÇO — issue #3372, fatia B, critérios 2 e 3.
 *
 * O que este arquivo mede é o que o banco não consegue medir sozinho: o 409 da
 * revisão velha (a rota manda `revision` no WHERE) e a régua aplicada sobre a
 * LINHA MESCLADA (um `unidade` novo sobre um `tipo` que já estava gravado).
 */
function mundo(opcoes: { leituras: unknown[]; familia?: unknown[]; atualizado?: unknown }) {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt-BR" },
    org: { orgId: ORG_ID },
  } as never);

  const leituras = [...opcoes.leituras];
  let gravado: Record<string, unknown> | null = null;

  const consulta = () => {
    const q: Record<string, unknown> = {};
    let ehUpdate = false;
    const mesmo = () => q;
    Object.assign(q, {
      select: mesmo,
      eq: mesmo,
      or: mesmo,
      order: mesmo,
      limit: mesmo,
      update: (payload: Record<string, unknown>) => {
        gravado = payload;
        ehUpdate = true;
        return q;
      },
      maybeSingle: async () => {
        // A escrita responde o que o banco responderia; as LEITURAS saem da fila
        // na ordem em que a rota as faz (linha atual, releitura, releitura).
        if (ehUpdate) return opcoes.atualizado ?? { data: null, error: null };
        return { data: leituras.shift() ?? null, error: null };
      },
      // `await` no construtor é como a rota lê a família (lista, não `single`).
      then: (resolve: (v: unknown) => unknown) =>
        resolve({ data: opcoes.familia ?? [], error: null }),
    });
    return q;
  };

  vi.mocked(createClient).mockResolvedValue({ from: () => consulta() } as never);

  return {
    get gravado() {
      return gravado;
    },
    async patch(corpo: unknown) {
      const { PATCH } = await import("./route");
      const res = await PATCH(
        new NextRequest(`http://localhost/api/v1/servicos/${SERVICO_ID}`, {
          method: "PATCH",
          body: JSON.stringify(corpo),
          headers: { "content-type": "application/json" },
        }),
        { params: Promise.resolve({ id: SERVICO_ID }) },
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
});

describe("PATCH /api/v1/servicos/[id]", () => {
  it("revisão velha devolve 409 com a revisão atual — nunca salva por cima", async () => {
    const m = mundo({
      // 1ª leitura: a linha que quem edita viu. 2ª: a releitura que distingue
      // "outra pessoa salvou" de "o serviço sumiu".
      leituras: [SERVICO, { revision: 7 }],
      familia: [{ id: SERVICO_ID, preco_cents: 120_000 }],
      atualizado: { data: null, error: null },
    });

    const { status, body } = await m.patch({ nome: "Novo nome", expected_revision: 3 });
    expect(status).toBe(409);
    expect((body.error as { details?: { revision_atual?: number } }).details?.revision_atual).toBe(
      7,
    );
    expect(m.gravado).not.toBeNull();
  });

  it("produto de prateleira responde 404 — esta rota é de serviço", async () => {
    const m = mundo({ leituras: [PRODUTO] });
    const { status } = await m.patch({ nome: "Novo nome", expected_revision: 1 });
    expect(status).toBe(404);
    expect(m.gravado).toBeNull();
  });

  it("unidade incompatível com o tipo GRAVADO é recusada antes do banco", async () => {
    const projeto = {
      ...SERVICO,
      tipo_servico: "projeto",
      unidade_cobranca: "valor_fechado",
      revision: 1,
    };
    const m = mundo({ leituras: [projeto], familia: [{ id: SERVICO_ID, preco_cents: 120_000 }] });

    const { status, body } = await m.patch({ unidade: "mes", expected_revision: 1 });
    expect(status).toBe(422);
    expect(body.error as unknown).toBeTruthy();
    expect(m.gravado).toBeNull();
  });

  it("sinal fixo acima da menor variação é recusado", async () => {
    const m = mundo({
      leituras: [SERVICO],
      familia: [
        { id: SERVICO_ID, preco_cents: 120_000 },
        { id: "55555555-5555-4555-8555-555555555555", preco_cents: 50_000 },
      ],
    });

    const { status, body } = await m.patch({
      sinal: { tipo: "fixo", valor: 60_000 },
      expected_revision: 3,
    });
    expect(status).toBe(422);
    const details = (body.error as { details?: Record<string, string[]> }).details ?? {};
    expect(JSON.stringify(details)).toContain("menor variação");
    expect(m.gravado).toBeNull();
  });

  it("PATCH válido grava o campo de serviço e devolve o serviço montado", async () => {
    const atualizado = { ...SERVICO, sinal_percentual: 20, revision: 4 };
    const m = mundo({
      leituras: [SERVICO, atualizado, atualizado],
      familia: [atualizado],
      atualizado: { data: atualizado, error: null },
    });

    const { status, body } = await m.patch({
      sinal: { tipo: "percentual", valor: 20 },
      expected_revision: 3,
    });
    expect(status).toBe(200);
    expect(m.gravado).toMatchObject({ sinal_tipo: "percentual", sinal_percentual: 20 });
    const servico = body.data as { preco_a_partir?: string; sinal?: { cents?: number } };
    expect(servico.sinal?.cents).toBe(24_000);
  });
});
