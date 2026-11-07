/**
 * O MODO "IA COM O DONO" NA ROTA (#3967, fatia 1).
 *
 * O que este arquivo mede: o CONTRATO DE ESCRITA da rota. O ponto da issue é que
 * a conversa ganha a IA sem perder o dono, então o teste não olha só a resposta
 * 200 — ele olha o PAYLOAD do UPDATE:
 *
 *   - escreve `metadata.ai_com_dono` e `bot_silenced_until`, e MAIS NADA;
 *   - não toca `assigned_to_user_id`/`assignee_kind`/`assigned_at`/`status`/
 *     contadores — é a ausência de escrita que prova "a conversa não perdeu o
 *     dono nem saiu da fila";
 *   - não chama `fn_conversation_assign` (o `release`/claim da RPC) em nenhum
 *     caminho.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Acrescentar `assigned_to_user_id: null` ao UPDATE: "escreve SÓ metadata e
 *   silêncio" acusa.
 * - Trocar `bot_silenced_until: null` por `SILENCIO_DURAVEL` no ramo de ligar:
 *   "ligar limpa o silêncio" acusa (e é o que faria o gate calar a IA).
 * - Remover a recusa de conversa sem dono: o caso 409 acusa.
 * - Remover a recusa de contato travado: os três casos de trava acusam.
 * - Remover a régua de dono do ligar: "agent que NÃO é o dono" acusa.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

import { POST } from "./route";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const EU = "22222222-2222-4222-8222-222222222222";
const OUTRO = "33333333-3333-4333-8333-333333333333";
const CONVERSA = "44444444-4444-4444-8444-444444444444";

interface Linha {
  id?: string;
  contact_id?: string | null;
  status?: string;
  assigned_to_user_id?: string | null;
  assignee_kind?: string | null;
  bot_silenced_until?: string | null;
  metadata?: unknown;
  contacts?: { force_human: boolean | null; ai_opt_out: boolean | null; is_blocked: boolean | null } | null;
}

/**
 * Dublê do client de request. Guarda o payload do UPDATE em `escritas` — é dele
 * que saem as asserções de "só isto foi escrito". `rpc` existe para provar que a
 * rota NÃO passa por `fn_conversation_assign`.
 */
function duble(linha: Linha | null) {
  const estado = { payload: null as Record<string, unknown> | null, rpc: [] as string[] };
  const base: Record<string, unknown> = {};
  base.select = () => base;
  base.eq = () => base;
  base.maybeSingle = async () => ({ data: linha, error: null });
  base.update = (payload: Record<string, unknown>) => {
    estado.payload = payload;
    const depois: Record<string, unknown> = {};
    depois.eq = () => depois;
    depois.select = () => depois;
    depois.maybeSingle = async () => ({ data: { id: CONVERSA, ...linha, ...payload }, error: null });
    return depois;
  };
  const client = {
    from: () => base,
    rpc: async (nome: string) => {
      estado.rpc.push(nome);
      return { data: null, error: null };
    },
  };
  vi.mocked(createClient).mockResolvedValue(client as never);
  return estado;
}

const chamar = (corpo: unknown = { ligado: true }) =>
  POST(
    new NextRequest(`http://localhost/api/v1/conversations/${CONVERSA}/ia-com-dono`, {
      method: "POST",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: CONVERSA }) },
  );

function sessao(role = "agent") {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: EU, idioma: "pt-BR" },
    org: { orgId: ORG, role },
  } as Awaited<ReturnType<typeof requireRole>>);
}

const comDono = (extra: Linha = {}): Linha => ({
  id: CONVERSA,
  contact_id: "55555555-5555-4555-8555-555555555555",
  status: "claimed",
  assigned_to_user_id: EU,
  assignee_kind: "user",
  bot_silenced_until: "infinity",
  metadata: { handoff_tecnico: { chamado: "T-1" } },
  contacts: { force_human: false, ai_opt_out: false, is_blocked: false },
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  sessao();
});

describe("ia-com-dono: ligar", () => {
  it("escreve metadata.ai_com_dono e limpa o silêncio — e MAIS NADA (o dono fica)", async () => {
    const estado = duble(comDono());
    const res = await chamar({ ligado: true });
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data.ai_com_dono).toBe(true);
    // O dono é o mesmo antes e depois: a resposta o devolve por nome.
    expect(corpo.data.dono_preservado).toBe(EU);

    const payload = estado.payload!;
    expect(Object.keys(payload).sort()).toEqual(["bot_silenced_until", "metadata"]);
    expect(payload.bot_silenced_until).toBeNull();
    expect(payload.metadata).toEqual({ handoff_tecnico: { chamado: "T-1" }, ai_com_dono: true });
  });

  it("NÃO chama fn_conversation_assign: nenhum release, nenhum claim", async () => {
    const estado = duble(comDono());
    await chamar({ ligado: true });
    expect(estado.rpc).toEqual([]);
  });

  it("preserva as outras marcas do jsonb (handoff_tecnico, devolucao_ao_rodizio)", async () => {
    const estado = duble(
      comDono({
        metadata: {
          handoff_tecnico: { chamado: "T-9" },
          devolucao_ao_rodizio: { devolucoes: 2 },
          ai_com_dono: false,
        },
      }),
    );
    await chamar({ ligado: true });

    expect(estado.payload!.metadata).toEqual({
      handoff_tecnico: { chamado: "T-9" },
      devolucao_ao_rodizio: { devolucoes: 2 },
      ai_com_dono: true,
    });
  });

  it("recusa conversa SEM dono (não há o que preservar) e não escreve", async () => {
    const estado = duble(comDono({ assigned_to_user_id: null, assignee_kind: null }));
    const res = await chamar({ ligado: true });
    const corpo = await res.json();

    expect(res.status).toBe(409);
    expect(corpo.error.message).toContain("não tem atendente");
    expect(estado.payload).toBeNull();
  });
});

describe("ia-com-dono: desligar", () => {
  it("remove a chave do metadata e devolve o silêncio durável (estado de hoje)", async () => {
    const estado = duble(comDono({ bot_silenced_until: null, metadata: { ai_com_dono: true } }));
    const res = await chamar({ ligado: false });
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data.ai_com_dono).toBe(false);

    const payload = estado.payload!;
    expect(Object.keys(payload).sort()).toEqual(["bot_silenced_until", "metadata"]);
    expect(payload.bot_silenced_until).toBe("infinity");
    // Desligar REMOVE a chave: quem nunca ligou tem o mesmo jsonb de antes.
    expect(payload.metadata).toEqual({});
  });

  it("desligar não exige dono (é o caminho de saída, não de entrada)", async () => {
    const estado = duble(comDono({ assigned_to_user_id: null, assignee_kind: null }));
    const res = await chamar({ ligado: false });

    expect(res.status).toBe(200);
    expect(estado.payload!.metadata).toEqual({ handoff_tecnico: { chamado: "T-1" } });
  });
});

describe("ia-com-dono: recusas (trava do contato e conversa encerrada)", () => {
  it.each([
    ["force_human", { force_human: true, ai_opt_out: false, is_blocked: false }, "humano obrigatório"],
    ["ai_opt_out", { force_human: false, ai_opt_out: true, is_blocked: false }, "não falar com a IA"],
    ["is_blocked", { force_human: false, ai_opt_out: false, is_blocked: true }, "bloqueado"],
  ])("contato com %s: 409 e nada é escrito", async (_nome, contato, trecho) => {
    const estado = duble(comDono({ contacts: contato }));
    const res = await chamar({ ligado: true });
    const corpo = await res.json();

    expect(res.status).toBe(409);
    expect(corpo.error.message).toContain(trecho);
    expect(estado.payload).toBeNull();
  });

  it.each([
    ["closed", { status: "closed" }],
    ["archived", { status: "archived" }],
  ])("conversa %s: 409 e nada é escrito", async (_nome, extra) => {
    const estado = duble(comDono(extra));
    const res = await chamar({ ligado: true });

    expect(res.status).toBe(409);
    expect(estado.payload).toBeNull();
  });

  it("conversa inexistente: 404", async () => {
    duble(null);
    const res = await chamar({ ligado: true });
    expect(res.status).toBe(404);
  });

  it("corpo inválido: 400 e nada é escrito", async () => {
    const estado = duble(comDono());
    const res = await chamar({ ligado: "sim" });

    expect(res.status).toBe(400);
    expect(estado.payload).toBeNull();
  });
});

describe("ia-com-dono: permissões da casa", () => {
  it("requireSupportWrite roda ANTES de tudo e barra a escrita em impersonação", async () => {
    const estado = duble(comDono());
    vi.mocked(requireSupportWrite).mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 }) as never,
    );

    const res = await chamar({ ligado: true });

    expect(res.status).toBe(403);
    expect(requireRole).not.toHaveBeenCalled();
    expect(estado.payload).toBeNull();
  });

  it("agent que NÃO é o dono não liga a IA na conversa do colega: 403 e nada é escrito", async () => {
    const estado = duble(comDono({ assigned_to_user_id: OUTRO }));
    const res = await chamar({ ligado: true });
    const corpo = await res.json();

    expect(res.status).toBe(403);
    expect(corpo.error.code).toBe("forbidden");
    expect(estado.payload).toBeNull();
  });

  it.each(["manager", "admin"])("%s liga a IA na conversa de outro atendente (o dono fica)", async (role) => {
    sessao(role);
    const estado = duble(comDono({ assigned_to_user_id: OUTRO }));
    const res = await chamar({ ligado: true });
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data.dono_preservado).toBe(OUTRO);
    expect(estado.payload!.bot_silenced_until).toBeNull();
  });

  it("agent que não é o dono DESLIGA (como o pausar): 200", async () => {
    const estado = duble(comDono({ assigned_to_user_id: OUTRO, metadata: { ai_com_dono: true } }));
    const res = await chamar({ ligado: false });

    expect(res.status).toBe(200);
    expect(estado.payload!.bot_silenced_until).toBe("infinity");
  });

  it("viewer não escreve (requireRole 'agent' recusa)", async () => {
    const estado = duble(comDono());
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), { status: 403 }),
    } as unknown as Awaited<ReturnType<typeof requireRole>>);

    const res = await chamar({ ligado: true });

    expect(res.status).toBe(403);
    expect(estado.payload).toBeNull();
  });
});
