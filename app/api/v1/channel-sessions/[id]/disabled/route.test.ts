/**
 * A ROTA DE PAUSA E O LAÇO DA CENTRAL (issue #2389).
 *
 * Os três passos que a issue mede, todos pelo MESMO handler:
 *
 *   pausar  → o item existe (kind novo, canal, autor, horário);
 *   retomar → o MESMO item está resolvido, sem clique de ninguém;
 *   re-pausar → continua sendo UM item só.
 *
 * O banco é falso, mas é o contrato real: o builder é PromiseLike e os filtros
 * são gravados, então "um item só" se prova por contagem e não por fé.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

import { PATCH } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";

interface Item {
  id: string;
  organization_id: string;
  kind: string;
  status: string;
  severity?: string;
  title?: string;
  body: string | null;
  ref_kind?: string;
  ref_id?: string | null;
}

interface Estado {
  metadata: Record<string, unknown>;
  itens: Item[];
  rpc: ReturnType<typeof vi.fn>;
  insercoes: number;
}

let estado: Estado;

/** O cliente falso: mesmo contrato do supabase (builder PromiseLike). */
function clienteFalso() {
  let proximo = 1;

  const deItens = () => {
    let acao: "select" | "insert" | "update" = "select";
    let payload: Record<string, unknown> = {};
    const filtros: Array<[string, unknown]> = [];
    const casando = () =>
      estado.itens.filter((linha) =>
        filtros.every(([c, v]) => (linha as unknown as Record<string, unknown>)[c] === v),
      );
    const executar = async () => {
      if (acao === "select") return { data: casando()[0] ?? null, error: null };
      if (acao === "insert") {
        estado.insercoes += 1;
        estado.itens.push({ id: `aviso-${proximo++}`, status: "open", body: null, ...payload } as Item);
        return { data: null, error: null };
      }
      const alvos = casando();
      for (const linha of alvos) Object.assign(linha, payload);
      return { data: alvos[0] ? { id: alvos[0].id } : null, error: null };
    };
    const c: Record<string, unknown> = {
      select: () => c,
      insert: (p: Record<string, unknown>) => {
        acao = "insert";
        payload = p;
        return c;
      },
      update: (p: Record<string, unknown>) => {
        acao = "update";
        payload = p;
        return c;
      },
      eq: (col: string, val: unknown) => {
        filtros.push([col, val]);
        return c;
      },
      limit: () => c,
      maybeSingle: () => executar(),
      then: (ok?: unknown, falhou?: unknown) => executar().then(ok as never, falhou as never),
    };
    return c;
  };

  return {
    rpc: estado.rpc,
    from(tabela: string) {
      if (tabela === "agent_inbox_items") return deItens();
      const c: Record<string, unknown> = {
        select: () => c,
        eq: () => c,
        maybeSingle: async () => ({
          data: {
            id: CANAL,
            organization_id: ORG,
            display_name: "Loja Centro",
            phone_number: "+5511999990000",
            archived_at: null,
            metadata: estado.metadata,
          },
          error: null,
        }),
      };
      return c;
    },
  };
}

const req = (disabled: boolean) =>
  new NextRequest("http://localhost/api/v1/channel-sessions/" + CANAL + "/disabled", {
    method: "PATCH",
    body: JSON.stringify({ disabled }),
  });

const corpo = () => (estado.itens[0]?.body ?? "").trim();

beforeEach(() => {
  vi.clearAllMocks();
  estado = {
    metadata: { disabled: false },
    itens: [],
    insercoes: 0,
    // A RPC REAL grava a chave no metadata (migration 0545); o falso tem de
    // fazer o mesmo, senão a leitura de depois do clique continua dizendo o que
    // o canal era ANTES dele — e o laço nunca dispararia.
    rpc: vi.fn(async (_nome: string, args: { p_desativado: boolean }) => {
      estado.metadata = { ...estado.metadata, disabled: args.p_desativado };
      return { data: 1, error: null };
    }),
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: {
      id: "99999999-9999-4999-8999-999999999999",
      full_name: "Ana Silva",
      email: "ana@exemplo.com",
      idioma: "pt-BR",
    },
    org: { orgId: ORG, role: "admin" },
  } as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(createAdminClient).mockImplementation(() => clienteFalso() as never);
});

describe("PATCH …/channel-sessions/[id]/disabled e a Central", () => {
  it("pausar ABRE o item, com o canal, o autor e o horário", async () => {
    estado.metadata = { disabled: false };
    const r = await PATCH(req(true), { params: Promise.resolve({ id: CANAL }) });

    expect(r.status).toBe(200);
    expect(estado.itens).toHaveLength(1);
    expect(estado.itens[0]).toMatchObject({
      organization_id: ORG,
      kind: "canal_pausado",
      severity: "warn",
      status: "open",
      ref_kind: "channel_session",
      ref_id: CANAL,
    });
    expect(corpo()).toContain("Loja Centro");
    expect(corpo()).toContain("Ana Silva");
    // O horário vem do relógio da chamada; o formato é o da interface.
    expect(corpo()).toMatch(/\d{2}\/\d{2}\/\d{2}/);
  });

  it("re-pausar (item já aberto) NÃO abre um segundo item", async () => {
    estado.metadata = { disabled: false };
    await PATCH(req(true), { params: Promise.resolve({ id: CANAL }) });
    expect(estado.itens).toHaveLength(1);
    // A rota é idempotente na RPC, mas o laço tem de segurar mesmo assim:
    // o item continua aberto e a segunda passada o ATUALIZA.
    estado.metadata = { disabled: true };
    await PATCH(req(true), { params: Promise.resolve({ id: CANAL }) });

    expect(estado.insercoes).toBe(1);
    expect(estado.itens).toHaveLength(1);
    expect(estado.itens[0]!.status).toBe("open");
  });

  it("retomar RESOLVE o item sem clique, com motivo `reativado` no corpo", async () => {
    estado.metadata = { disabled: false };
    await PATCH(req(true), { params: Promise.resolve({ id: CANAL }) });
    expect(estado.itens[0]!.status).toBe("open");

    estado.metadata = { disabled: true };
    const r = await PATCH(req(false), { params: Promise.resolve({ id: CANAL }) });

    expect(r.status).toBe(200);
    expect(estado.itens).toHaveLength(1);
    expect(estado.itens[0]!.status).toBe("resolved");
    expect(corpo()).toContain("Resolvido pelo sistema: o canal foi reativado.");
    expect(corpo()).toContain("Ana Silva");
  });

  it("retomar sem item aberto não abre nem fecha nada", async () => {
    estado.metadata = { disabled: true };
    const r = await PATCH(req(false), { params: Promise.resolve({ id: CANAL }) });

    expect(r.status).toBe(200);
    expect(estado.itens).toHaveLength(0);
  });
});
