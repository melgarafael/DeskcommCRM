/**
 * O funil ARQUIVADO não tinha caminho de volta (#979).
 *
 * Medido em `main@cf35c944` (1.28.0), lendo o código:
 *   - `corpo()` em `app/api/v1/pipelines/_funis.ts` faz
 *     `filter((f) => !f.is_archived)`, então a tela NUNCA recebe um arquivado e
 *     não tem o que desenhar;
 *   - o `PATCH` recusa arquivado com `409 state_conflict` para QUALQUER campo, e
 *     o `bodySchema` é `.strict()` sem `is_archived` — desarquivar não existe;
 *   - o `DELETE?definitivo=1` funciona, mas a tela nunca o manda.
 *
 * O efeito, relatado por quem usa uma instalação real: *"pena que tenho funis
 * arquivados que não consigo deletar"*. O funil fica invisível, indestrutível, e
 * ainda ocupa `uniq_crm_pipelines_org_slug` — que não é parcial em
 * `is_archived` —, então o nome dele também não pode ser reusado.
 *
 * Duas garantias aqui, e a segunda é a que sobrevive ao tempo:
 *   1. o arquivado VOLTA — aparece num campo próprio e o PATCH aceita tirá-lo do
 *      arquivo;
 *   2. ele volta SEM VAZAR: `pipelines` continua só com os vivos, porque é essa
 *      lista que alimenta os seletores de funil do produto inteiro, e foi
 *      justamente o vazamento de funil arquivado que os PRs #941 e #944
 *      consertaram em outras telas.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { corpo } from "@/app/api/v1/pipelines/_funis";
import { PATCH } from "@/app/api/v1/pipelines/[id]/route";
import { ORG_ID, PIPE, authOk, funilRow, makeDb } from "@/tests/helpers/stages-db-double";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ARQUIVADO = "55555555-5555-4555-8555-555555555555";

function patch(id: string, body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new NextRequest(`http://localhost/api/v1/pipelines/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.mocked(requireRole).mockReset();
  vi.mocked(createClient).mockReset();
  authOk();
});

describe("funil arquivado — o caminho de volta (#979)", () => {
  it("a resposta separa os arquivados dos vivos, em vez de escondê-los", () => {
    const body = corpo([
      funilRow({ id: PIPE, name: "Vendas" }),
      funilRow({ id: ARQUIVADO, name: "GMN antigo", is_archived: true }),
    ]);

    // Os vivos continuam sozinhos em `pipelines`: é essa lista que alimenta os
    // seletores de funil do produto, e funil morto ali seria o defeito de volta.
    expect(body.pipelines.map((p) => p.id)).toEqual([PIPE]);
    expect(body.arquivados.map((p) => p.id)).toEqual([ARQUIVADO]);
    expect(body.arquivados[0]?.name).toBe("GMN antigo");
  });

  it("o PATCH tira o funil do arquivo quando o pedido é só esse", async () => {
    const db = makeDb({
      pipelines: [
        funilRow({ id: PIPE, name: "Vendas", is_default: true }),
        funilRow({ id: ARQUIVADO, name: "GMN antigo", is_archived: true }),
      ],
    });
    vi.mocked(createClient).mockResolvedValue(db.client as never);

    const res = await patch(ARQUIVADO, { is_archived: false });

    expect(res.status).toBe(200);
    const escrita = db.escritas.find((e) => e.table === "crm_pipelines");
    expect(escrita?.patch).toMatchObject({ is_archived: false });
    expect(escrita?.filtros).toContainEqual(["organization_id", ORG_ID]);
  });

  it("o resto continua recusado: editar um funil que sumiu da lista segue 409", async () => {
    const db = makeDb({
      pipelines: [
        funilRow({ id: PIPE, name: "Vendas", is_default: true }),
        funilRow({ id: ARQUIVADO, name: "GMN antigo", is_archived: true }),
      ],
    });
    vi.mocked(createClient).mockResolvedValue(db.client as never);

    const res = await patch(ARQUIVADO, { name: "GMN novo" });

    expect(res.status).toBe(409);
    expect(db.escritas.filter((e) => e.table === "crm_pipelines")).toHaveLength(0);
  });

  it("desarquivar junto com outra mudança é recusado — o pedido misto vira edição", async () => {
    const db = makeDb({
      pipelines: [
        funilRow({ id: PIPE, name: "Vendas", is_default: true }),
        funilRow({ id: ARQUIVADO, name: "GMN antigo", is_archived: true }),
      ],
    });
    vi.mocked(createClient).mockResolvedValue(db.client as never);

    const res = await patch(ARQUIVADO, { is_archived: false, name: "GMN novo" });

    expect(res.status).toBe(409);
    expect(db.escritas.filter((e) => e.table === "crm_pipelines")).toHaveLength(0);
  });
});
