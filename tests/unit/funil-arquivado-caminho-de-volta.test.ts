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
import { DELETE, PATCH } from "@/app/api/v1/pipelines/[id]/route";
import { ORG_ID, PIPE, authOk, funilRow, makeDb } from "@/tests/helpers/stages-db-double";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ARQUIVADO = "55555555-5555-4555-8555-555555555555";
/** O funil ATIVO que passou a usar o nome enquanto o outro estava no arquivo (#2559). */
const OCUPANTE = "66666666-6666-4666-8666-666666666666";
/** O funil marcado como funil de clientes (#2559). */
const CLIENTES = "77777777-7777-4777-8777-777777777777";

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

/** A porta de arquivar (`DELETE` sem `?definitivo=1`) — é ela que conta as dependências. */
function arquivar(id: string): Promise<Response> {
  return DELETE(
    new NextRequest(`http://localhost/api/v1/pipelines/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) },
  );
}

async function mensagem(res: Response): Promise<string> {
  return ((await res.json()) as { error: { message: string } }).error.message;
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

  /**
   * #2559/1 — o nome NÃO era conferido na volta. O pedido misto (desarquivar +
   * renomear) é recusado de propósito, então este era o ÚNICO caminho em que a
   * lista podia terminar com dois funis iguais: alguém cria outro ativo com o
   * mesmo nome enquanto o primeiro está no arquivo, e o update simples devolve
   * o antigo sem avisar. A recusa é 409 com o conselho — mesma família do 409
   * do pedido misto, e sem renomeação automática.
   */
  it("tirar do arquivo com o nome já ocupado por um ATIVO é recusado com o conselho (#2559)", async () => {
    const db = makeDb({
      pipelines: [
        funilRow({ id: PIPE, name: "Vendas", is_default: true }),
        funilRow({ id: OCUPANTE, name: "GMN antigo" }),
        // Caixa e espaço sobrando: quem digita "gmn antigo " é o MESMO funil
        // para `chaveDeNome`, e a régua tem de casar igual.
        funilRow({ id: ARQUIVADO, name: " GMN ANTIGO ", is_archived: true }),
      ],
    });
    vi.mocked(createClient).mockResolvedValue(db.client as never);

    const res = await patch(ARQUIVADO, { is_archived: false });

    expect(res.status).toBe(409);
    const texto = await mensagem(res);
    // Cita o funil que a pessoa VÊ na lista (o ativo), e dá a saída.
    expect(texto).toContain("GMN antigo");
    expect(texto).toContain("Renomeie um dos dois");
    expect(db.escritas.filter((e) => e.table === "crm_pipelines")).toHaveLength(0);
  });

  /**
   * #2559/2 — a marca `is_client_pipeline` ficava presa no funil arquivado:
   * enquanto ele estava no arquivo o lead de cliente caía no padrão
   * (`lib/leads/nascimento-do-lead.ts` filtra `is_archived = false` junto da
   * marca), e ao tirar do arquivo a marca voltava sem ninguém ter escolhido.
   * O molde é o do funil padrão, que já era recusado assim — `MarcaExclusiva`
   * é um tipo só para as duas marcas serem a mesma regra.
   */
  it("arquivar o funil de clientes sem outro marcado é recusado com o conselho (#2559)", async () => {
    const db = makeDb({
      pipelines: [
        funilRow({ id: PIPE, name: "Vendas", is_default: true }),
        funilRow({ id: CLIENTES, name: "Clientes", is_client_pipeline: true }),
      ],
    });
    vi.mocked(createClient).mockResolvedValue(db.client as never);

    const res = await arquivar(CLIENTES);

    expect(res.status).toBe(422);
    const texto = await mensagem(res);
    expect(texto).toContain("«Clientes» é o funil de clientes");
    expect(texto).toContain("Marque OUTRO funil como funil de clientes");
    // Nenhuma escrita: nem `is_archived: true` sai.
    expect(db.escritas.filter((e) => e.table === "crm_pipelines")).toHaveLength(0);
  });

  /** A regressão da regressão: a recusa nova não pode travar o arquivar comum. */
  it("arquivar um funil sem marca continua gravando só is_archived", async () => {
    const db = makeDb({
      pipelines: [
        funilRow({ id: PIPE, name: "Vendas", is_default: true }),
        funilRow({ id: CLIENTES, name: "Clientes" }),
      ],
    });
    vi.mocked(createClient).mockResolvedValue(db.client as never);

    const res = await arquivar(CLIENTES);

    expect(res.status).toBe(200);
    const escrita = db.escritas.find((e) => e.table === "crm_pipelines");
    expect(escrita?.patch).toEqual({ is_archived: true });
  });
});
