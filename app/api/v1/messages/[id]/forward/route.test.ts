/**
 * POST /api/v1/messages/[id]/forward — o `apiClient` carimba Idempotency-Key em
 * todo POST, então um duplo clique ou uma retentativa de rede chegam com a MESMA
 * chave. A prova é a CONTAGEM de encaminhamentos, não a igualdade das respostas
 * (devolver o recibo E encaminhar de novo passaria na igualdade).
 *
 * `comIdempotencia` roda de VERDADE sobre um banco falso de `idempotency_keys`;
 * só o `encaminharMensagem` é dublado — o caminho dele tem testes próprios
 * (`tests/unit/encaminhar-*`).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/inbox/encaminhar-mensagem", () => ({ encaminharMensagem: vi.fn() }));

import { ApiError } from "@/lib/api/types";
import { requireRole } from "@/lib/auth/require-role";
import { encaminharMensagem } from "@/lib/inbox/encaminhar-mensagem";
import { createClient } from "@/lib/supabase/server";

import { POST } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const MENSAGEM = "22222222-2222-4222-8222-222222222222";
const DESTINO = "44444444-4444-4444-8444-444444444444";
const OUTRO_DESTINO = "55555555-5555-4555-8555-555555555555";
const CHAVE = "aaaaaaa1-1111-4111-8111-111111111111";

const mockedEncaminhar = vi.mocked(encaminharMensagem);

type Linha = Record<string, unknown>;

/** As cadeias que `comIdempotencia` encadeia, sobre uma tabela em memória. */
function bancoFalso() {
  const linhas: Linha[] = [];
  const from = () => {
    const eq: Array<[string, unknown]> = [];
    let gt: [string, unknown] | null = null;
    let patch: Linha | null = null;
    let inserindo: Linha | null = null;
    const casa = (l: Linha) =>
      eq.every(([c, v]) => l[c] === v) && (gt ? String(l[gt[0]]) > String(gt[1]) : true);
    const aplicar = () => {
      if (patch) for (const l of linhas.filter(casa)) Object.assign(l, patch);
      if (inserindo) linhas.push(inserindo);
      patch = inserindo = null;
    };
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (c: string, v: unknown) => (eq.push([c, v]), b);
    b.is = (c: string, v: unknown) => (eq.push([c, v]), b);
    b.gt = (c: string, v: unknown) => ((gt = [c, v]), b);
    b.insert = (l: Linha) => ((inserindo = l), b);
    b.update = (p: Linha) => ((patch = p), b);
    b.maybeSingle = async () => (aplicar(), { data: linhas.find(casa) ?? null, error: null });
    b.single = async () => {
      aplicar();
      const l = linhas.find(casa);
      return { data: l ?? null, error: l ? null : { message: "no rows" } };
    };
    b.then = (comOk: (v: unknown) => unknown, comErro: (e: unknown) => unknown) => {
      aplicar();
      return Promise.resolve({ data: null, error: null }).then(comOk, comErro);
    };
    return b;
  };
  return { from };
}

function pedido(chave: string | null, destino = DESTINO): NextRequest {
  return new NextRequest(`http://localhost/api/v1/messages/${MENSAGEM}/forward`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(chave ? { "Idempotency-Key": chave } : {}) },
    body: JSON.stringify({ conversation_id: destino }),
  });
}

const ctx = { params: Promise.resolve({ id: MENSAGEM }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId: ORG_ID },
  } as never);
  vi.mocked(createClient).mockResolvedValue(bancoFalso() as never);
  mockedEncaminhar.mockResolvedValue({ id: "m-novo", status: "sent" } as never);
});

describe("POST /api/v1/messages/[id]/forward — idempotência", () => {
  it("mesma chave e mesmo destino: DUAS chamadas, UM encaminhamento, a MESMA resposta", async () => {
    const primeira = await POST(pedido(CHAVE), ctx);
    const segunda = await POST(pedido(CHAVE), ctx);

    expect(primeira.status).toBe(201);
    expect(segunda.status).toBe(201);
    expect(mockedEncaminhar).toHaveBeenCalledTimes(1);
    expect(await segunda.json()).toEqual(await primeira.json());
  });

  it("mesma chave com outro destino: 409 idempotency_conflict, sem encaminhar de novo", async () => {
    await POST(pedido(CHAVE), ctx);
    const res = await POST(pedido(CHAVE, OUTRO_DESTINO), ctx);

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("idempotency_conflict");
    expect(mockedEncaminhar).toHaveBeenCalledTimes(1);
  });

  it("chave que não é UUID: 400 e nada é encaminhado", async () => {
    const res = await POST(pedido("nao-e-uuid"), ctx);
    expect(res.status).toBe(400);
    expect(mockedEncaminhar).not.toHaveBeenCalled();
  });

  it("sem chave: encaminha a cada chamada (o caminho de sempre)", async () => {
    await POST(pedido(null), ctx);
    await POST(pedido(null), ctx);
    expect(mockedEncaminhar).toHaveBeenCalledTimes(2);
  });

  it("a recusa repassa `details` (a janela de 24h promete `use: \"template\"`)", async () => {
    mockedEncaminhar.mockRejectedValueOnce(
      new ApiError(422, "window_closed", { use: "template" }, "req", "Janela fechada."),
    );
    const res = await POST(pedido(null), ctx);
    expect(res.status).toBe(422);
    expect((await res.json()).error.details).toEqual({ use: "template" });
  });
});
