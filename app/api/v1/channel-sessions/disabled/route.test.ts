/**
 * AÇÃO EM LOTE na Central de Conexões — a conta que a resposta declara (issue #2387).
 *
 * Os cinco enganos que este arquivo cobre, todos medidos contra a rota unitária
 * que já existia (`[id]/disabled`):
 *
 *  1. "uma ação pausa os 3" sem virar 3 requisições — e UM audit por canal,
 *     cada um com o autor e o MESMO requestId (a trilha que a auditoria lê);
 *  2. repetir a ação não regrava nada e NÃO enche o histórico de eventos que não
 *     representam mudança (idempotência: `jaEstavam`, sem RPC e sem audit);
 *  3. canal arquivado (excluído) fica FORA da operação — nem erro, nem RPC, nem
 *     audit: exclusão não vira pausa;
 *  4. falha parcial declara OS IDS QUE FALHARAM na ordem pedida, nunca sucesso
 *     falso;
 *  5. sem papel admin não há leitura sequer (403 antes do service role).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { PATCH, MAX_LOTE } from "./route";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const org = "11111111-1111-4111-8111-111111111111";
const autor = "99999999-9999-4999-8999-999999999999";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SUMIU = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
/** `n` UUIDs válidos e distintos — a fronteira do teto se mede com ids que o formato aceita. */
const lote = (n: number) =>
  Array.from({ length: n }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${i.toString(16).padStart(12, "0")}`);

/** Linhas que a leitura devolve (o `in` do mock já recorta pelos ids pedidos). */
let linhas: { id: string; metadata: Record<string, unknown> | null; archived_at: string | null }[] = [];
/** Filtros aplicados na leitura — é assim que a régua de tenant se prova. */
let filtros: Record<string, unknown> = {};
let rpc: ReturnType<typeof vi.fn>;
/** Comportamento do RPC por canal: 1 = mudou, 0 = sumiu/arquivou na corrida. */
let comportamentoRpc: (canal: string) => { data: unknown; error: unknown };

const ligado = (id: string, over: Partial<{ metadata: Record<string, unknown> | null; archived_at: string | null }> = {}) => ({
  id,
  metadata: {},
  archived_at: null,
  ...over,
});

const req = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/channel-sessions/disabled", {
    method: "PATCH",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  linhas = [];
  filtros = {};
  comportamentoRpc = () => ({ data: 1, error: null });
  vi.mocked(loadAuthUser).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: autor },
    org: { orgId: org, role: "admin" },
  } as Awaited<ReturnType<typeof requireRole>>);

  rpc = vi.fn(async (_nome: string, args: { p_canal: string }) => comportamentoRpc(args.p_canal));

  const query = {
    select: () => query,
    eq: (chave: string, valor: unknown) => {
      filtros[chave] = valor;
      return query;
    },
    in: (chave: string, ids: string[]) => {
      filtros[chave] = ids;
      return Promise.resolve({ data: linhas.filter((l) => ids.includes(l.id)), error: null });
    },
  };
  vi.mocked(createAdminClient).mockReturnValue({ from: () => query, rpc } as unknown as ReturnType<
    typeof createAdminClient
  >);
});

describe("ação em lote de pausa/retomada", () => {
  it("sem papel admin recebe 403 e não lê nem audita nada", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: fail("forbidden", "Acesso negado.", 403) });
    const response = await PATCH(req({ disabled: true, ids: [A] }));
    expect(response.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("suporte somente-leitura é barrado antes do service role e do audit", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue({
      id: autor,
      is_platform_admin: true,
      support: { organization_id: org, status: "active", access_mode: "support_readonly" },
    } as Awaited<ReturnType<typeof loadAuthUser>>);
    const response = await PATCH(req({ disabled: true, ids: [A] }));
    expect(response.status).toBe(403);
    expect(requireRole).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("três canais ligados: uma ação pausa os 3 e audita um evento por canal com o autor", async () => {
    linhas = [ligado(A), ligado(B), ligado(C)];
    const response = await PATCH(req({ disabled: true, ids: [A, B, C] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { disabled: true, pedidos: 3, alterados: 3, jaEstavam: 0, arquivados: 0, falharam: [] },
    });
    // Escopo: a leitura sai da ORGANIZAÇÃO da sessão, nunca do body.
    expect(filtros).toMatchObject({ organization_id: org, id: [A, B, C] });
    expect(rpc).toHaveBeenCalledTimes(3);
    for (const canal of [A, B, C]) {
      expect(rpc).toHaveBeenCalledWith("fn_definir_canal_desativado", {
        p_org: org,
        p_canal: canal,
        p_desativado: true,
      });
    }
    // Um audit POR CANAL, com o autor — e os três eventos da MESMA requisição.
    expect(audit).toHaveBeenCalledTimes(3);
    const chamadas = vi.mocked(audit).mock.calls.map(([evento]) => evento);
    expect(chamadas.map((e) => e.resourceId).sort()).toEqual([A, B, C].sort());
    expect(chamadas.every((e) => e.action === "channel.disabled")).toBe(true);
    expect(chamadas.every((e) => e.actorUserId === autor && e.organizationId === org)).toBe(true);
    expect(new Set(chamadas.map((e) => e.requestId)).size).toBe(1);
  });

  it("repetir a mesma ação muda nada e não gera audit novo", async () => {
    linhas = [ligado(A, { metadata: { disabled: true } }), ligado(B, { metadata: { disabled: true } })];
    const response = await PATCH(req({ disabled: true, ids: [A, B] }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      disabled: true,
      pedidos: 2,
      alterados: 0,
      jaEstavam: 2,
      arquivados: 0,
      falharam: [],
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("canal arquivado fica fora: sem RPC, sem audit e sem erro", async () => {
    linhas = [ligado(A), ligado(B, { archived_at: "2026-09-01T00:00:00Z" })];
    const response = await PATCH(req({ disabled: true, ids: [A, B] }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      disabled: true,
      pedidos: 2,
      alterados: 1,
      jaEstavam: 0,
      arquivados: 1,
      falharam: [],
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("fn_definir_canal_desativado", {
      p_org: org,
      p_canal: A,
      p_desativado: true,
    });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]?.[0].resourceId).toBe(A);
  });

  it("falha parcial lista os ids que falharam e não afirma sucesso total", async () => {
    linhas = [ligado(A), ligado(B), ligado(C)];
    comportamentoRpc = (canal) =>
      canal === B
        ? { data: null, error: { message: "rpc estourou" } }
        : canal === C
          ? { data: 0, error: null } // arquivado na corrida: 0 linha alterada
          : { data: 1, error: null };
    const response = await PATCH(req({ disabled: true, ids: [A, B, C] }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      disabled: true,
      pedidos: 3,
      alterados: 1,
      jaEstavam: 0,
      arquivados: 0,
      falharam: [B, C],
    });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]?.[0].resourceId).toBe(A);
  });

  it("id que não existe nesta organização entra em falharam, na ordem pedida", async () => {
    linhas = [ligado(A)];
    const response = await PATCH(req({ disabled: true, ids: [SUMIU, A] }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      disabled: true,
      pedidos: 2,
      alterados: 1,
      jaEstavam: 0,
      arquivados: 0,
      falharam: [SUMIU],
    });
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("retomar usa a MESMA RPC com p_desativado false e audita channel.enabled", async () => {
    linhas = [ligado(A, { metadata: { disabled: true } }), ligado(B, { metadata: { disabled: true } })];
    const response = await PATCH(req({ disabled: false, ids: [A, B] }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ disabled: false, alterados: 2, falharam: [] });
    expect(rpc).toHaveBeenCalledWith("fn_definir_canal_desativado", {
      p_org: org,
      p_canal: A,
      p_desativado: false,
    });
    expect(vi.mocked(audit).mock.calls.every(([evento]) => evento.action === "channel.enabled")).toBe(true);
  });

  it("id repetido no pedido vira uma ação só", async () => {
    linhas = [ligado(A)];
    const response = await PATCH(req({ disabled: true, ids: [A, A, A] }));
    expect((await response.json()).data).toMatchObject({ pedidos: 1, alterados: 1 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("body inválido é recusado com 422 antes de qualquer leitura", async () => {
    for (const body of [
      null,
      { ids: [A] },
      { disabled: "sim", ids: [A] },
      { disabled: true, ids: [] },
      { disabled: true, ids: ["nao-e-uuid"] },
      // UUIDs VÁLIDOS: com ids malformados o 422 vinha do formato, e tirar o
      // `.max(MAX_LOTE)` da rota deixava este caso verde.
      { disabled: true, ids: lote(MAX_LOTE + 1) },
      { disabled: true, ids: [A], descarte: true },
    ]) {
      const response = await PATCH(req(body));
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect((await response.json()).error.code).toBe("validation_failed");
    }
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("exatamente MAX_LOTE ids passa pelo teto (51 é que não passa)", async () => {
    const ids = lote(MAX_LOTE);
    const response = await PATCH(req({ disabled: true, ids }));
    expect(response.status).toBe(200);
    // `linhas` vazio: nenhum existe nesta organização, então os 50 caem em falharam.
    expect((await response.json()).data).toMatchObject({ pedidos: MAX_LOTE, alterados: 0, falharam: ids });
  });
});
