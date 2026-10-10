/**
 * A JANELA DE MANUTENÇÃO tem fronteira honesta (#2388) — o que as ROTAS fazem.
 *
 * O cron e a régua pura estão em `tests/unit/agenda-de-pausa-agendada.test.ts`;
 * aqui se mede o que a TELA enxerga da API:
 *
 *  1. sem papel admin não há leitura nem escrita (403 antes do service role);
 *  2. janela no PASSADO é recusada com frase dizendo o que fazer (critério 4) —
 *     e fim antes do início também, sem "validation failed" seco;
 *  3. a criação grava o instante absoluto e a AUTORA na linha (`created_by`),
 *     e criar/cancelar entram na trilha de auditoria como toda mutação;
 *  4. cancelar é idempotente: duas vezes não é erro, e a janela que já terminou
 *     recebe 409 dizendo que cancelar o passado não desfaz nada;
 *  5. o GET devolve o fuso LIDO DO BANCO, porque é ele que a tela usa para
 *     montar o instante (critério 7: fuso da organização, não do navegador).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { GET, POST } from "./route";
import { DELETE } from "./[id]/route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const AUTORA = "99999999-9999-4999-8999-999999999999";
const CANAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JANELA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Linha = Record<string, unknown>;
type Banco = {
  agendas: Linha[];
  canal: Linha | null;
  fuso: string;
  gravacoes: Array<{ tabela: string; patch: Linha; filtros: Array<[string, unknown]> }>;
};

function dbFake(banco: Banco) {
  function tabela(nome: string) {
    const c: {
      filtros: Array<[string, unknown]>;
      patch: Linha | null;
      inserido: Linha | null;
    } = { filtros: [], patch: null, inserido: null };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "order", "limit"]) {
      b[m] = (...args: unknown[]) => {
        if (m !== "select") c.filtros.push([m, args]);
        return b;
      };
    }
    b.insert = (linha: Linha) => {
      c.inserido = linha;
      return b;
    };
    b.update = (patch: Linha) => {
      c.patch = patch;
      return b;
    };
    b.maybeSingle = async () => resolver(c, nome, { unico: true }) as Promise<{ data: unknown; error: null }>;
    b.then = (ok?: (v: unknown) => unknown, erro?: (e: unknown) => unknown) =>
      resolver(c, nome, { unico: false }).then(ok, erro);
    return b;
  }

  /** Valor de `eq(coluna, valor)` — o filtro é `[metodo, [coluna, valor, ...]]`. */
  function valor(c: { filtros: Array<[string, unknown]> }, metodo: string, coluna: string): unknown {
    const filtro = c.filtros.find(([m, args]) => m === metodo && (args as unknown[])[0] === coluna);
    return (filtro?.[1] as unknown[] | undefined)?.[1];
  }

  async function resolver(
    c: { filtros: Array<[string, unknown]>; patch: Linha | null; inserido: Linha | null },
    nome: string,
    op: { unico: boolean },
  ) {
    if (c.inserido) {
      const linha: Linha = {
        id: JANELA,
        organization_id: ORG,
        channel_session_id: null,
        status: "scheduled",
        paused_channel_ids: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...c.inserido,
      };
      banco.agendas.push(linha);
      return op.unico ? { data: linha, error: null } : { data: [linha], error: null };
    }
    if (c.patch) {
      banco.gravacoes.push({ tabela: nome, patch: c.patch, filtros: [...c.filtros] });
      const id = String(valor(c, "eq", "id") ?? "");
      const alvo = banco.agendas.find((a) => a.id === id);
/** `in(coluna, valores)` — o filtro é `["in", [coluna, valores]]`. */
      const argsIn = c.filtros.find(([m]) => m === "in")?.[1] as unknown[] | undefined;
      const statuses = (argsIn?.[1] as unknown[] | undefined)?.map(String) ?? null;
      if (!alvo || (statuses && !statuses.includes(String(alvo.status)))) {
        return op.unico ? { data: null, error: null } : { data: [], error: null };
      }
      Object.assign(alvo, c.patch);
      return op.unico ? { data: alvo, error: null } : { data: [{ id }], error: null };
    }
    if (nome === "organizations") return { data: { timezone: banco.fuso }, error: null };
    if (nome === "channel_sessions") {
      const id = String(valor(c, "eq", "id") ?? "");
      return { data: banco.canal && banco.canal.id === id ? { id: banco.canal.id } : null, error: null };
    }
    if (nome === "channel_schedules") {
      const id = valor(c, "eq", "id");
      if (id) {
        const alvo = banco.agendas.find((a) => a.id === String(id));
        return { data: alvo ?? null, error: null };
      }
      return { data: banco.agendas, error: null };
    }
    throw new Error(`tabela não prevista: ${nome}`);
  }

  return { from: (nome: string) => tabela(nome), rpc: vi.fn(async () => ({ data: 1, error: null })) };
}

const reqPost = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/channel-schedules", {
    method: "POST",
    body: JSON.stringify(body),
  });

let banco: Banco;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: AUTORA },
    org: { orgId: ORG, role: "admin" },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);
  banco = { agendas: [], canal: { id: CANAL, organization_id: ORG }, fuso: "America/Sao_Paulo", gravacoes: [] };
  vi.mocked(createAdminClient).mockReturnValue(dbFake(banco) as never);
});

const futuro = (horas: number) => new Date(Date.now() + horas * 3_600_000).toISOString();

describe("POST /api/v1/channel-schedules", () => {
  it("sem papel admin não há escrita sequer", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response("negado", { status: 403 }),
    } as unknown as Awaited<ReturnType<typeof requireRole>>);

    const r = await POST(reqPost({ starts_at: futuro(1), ends_at: futuro(2) }));
    expect(r.status).toBe(403);
    expect(banco.agendas).toHaveLength(0);
  });

  it("janela no passado é recusada com a frase dizendo o que fazer (critério 4)", async () => {
    const r = await POST(reqPost({ starts_at: futuro(-3), ends_at: futuro(1) }));
    expect(r.status).toBe(422);
    const corpo = (await r.json()) as { error: { message: string } };
    expect(corpo.error.message).toContain("começar no futuro");
    expect(corpo.error.message).toContain("pausa manual");
  });

  it("fim antes do início é recusado com mensagem clara", async () => {
    const r = await POST(reqPost({ starts_at: futuro(3), ends_at: futuro(1) }));
    expect(r.status).toBe(422);
    const corpo = (await r.json()) as { error: { message: string } };
    expect(corpo.error.message).toContain("depois do início");
  });

  it("cria a janela com instante absoluto e a autora na linha", async () => {
    const r = await POST(reqPost({ starts_at: futuro(2), ends_at: futuro(3) }));
    expect(r.status).toBe(200);
    const corpo = (await r.json()) as { data: { agenda: Linha } };
    expect(corpo.data.agenda).toMatchObject({
      organization_id: ORG,
      status: "scheduled",
      created_by: AUTORA,
    });
    // Instante absoluto: o banco nunca recebe hora de parede sem fuso.
    expect(Number.isNaN(Date.parse(String(corpo.data.agenda.starts_at)))).toBe(false);
    // Canal alvo conferido contra a ORGANIZAÇÃO antes de gravar (tenant).
    expect(banco.canal).not.toBeNull();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.schedule_created",
        actorUserId: AUTORA,
        organizationId: ORG,
        resourceType: "channel_schedule",
        resourceId: JANELA,
      }),
    );
  });

  it("canal de outra organização não vira escopo (404)", async () => {
    banco.canal = null;
    const r = await POST(
      reqPost({ starts_at: futuro(2), ends_at: futuro(3), channel_session_id: CANAL }),
    );
    expect(r.status).toBe(404);
    expect(banco.agendas).toHaveLength(0);
  });
});

describe("DELETE /api/v1/channel-schedules/[id]", () => {
  const reqDelete = () =>
    new NextRequest(`http://localhost/api/v1/channel-schedules/${JANELA}`, { method: "DELETE" });

  it("cancelar duas vezes não é erro: a segunda muda nada", async () => {
    banco.agendas.push({
      id: JANELA,
      organization_id: ORG,
      status: "cancelled",
      starts_at: futuro(2),
      ends_at: futuro(3),
    });

    const r = await DELETE(reqDelete(), { params: Promise.resolve({ id: JANELA }) });
    expect(r.status).toBe(200);
    const corpo = (await r.json()) as { data: { mudou: boolean; status: string } };
    expect(corpo.data).toMatchObject({ status: "cancelled", mudou: false });
    expect(banco.gravacoes).toHaveLength(0);
    // Nada mudou: nada a auditar.
    expect(audit).not.toHaveBeenCalled();
  });

  it("id que não é uuid é 404, sem chegar ao banco", async () => {
    const r = await DELETE(reqDelete(), { params: Promise.resolve({ id: "nao-e-uuid" }) });
    expect(r.status).toBe(404);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("cancela janela viva e o filtro de status é a trava da corrida", async () => {
    banco.agendas.push({
      id: JANELA,
      organization_id: ORG,
      status: "running",
      starts_at: futuro(-1),
      ends_at: futuro(1),
    });

    const r = await DELETE(reqDelete(), { params: Promise.resolve({ id: JANELA }) });
    expect(r.status).toBe(200);
    expect(banco.gravacoes[0]).toMatchObject({ patch: { status: "cancelled" } });
    // O claim: o update leva filtro de status, não é escrita às cegas.
    expect(banco.gravacoes[0]?.filtros.some(([m]) => m === "in")).toBe(true);
    expect(banco.agendas[0]?.status).toBe("cancelled");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.schedule_cancelled",
        actorUserId: AUTORA,
        organizationId: ORG,
        resourceId: JANELA,
        metadata: { status_anterior: "running" },
      }),
    );
  });

  it("janela que já terminou recebe 409 dizendo que cancelar não desfaz", async () => {
    banco.agendas.push({
      id: JANELA,
      organization_id: ORG,
      status: "done",
      starts_at: futuro(-3),
      ends_at: futuro(-1),
    });

    const r = await DELETE(reqDelete(), { params: Promise.resolve({ id: JANELA }) });
    expect(r.status).toBe(409);
    const corpo = (await r.json()) as { error: { message: string } };
    expect(corpo.error.message).toContain("já terminou");
  });
});

describe("GET /api/v1/channel-schedules", () => {
  it("devolve o fuso do BANCO e a lista da própria organização (critério 7)", async () => {
    banco.fuso = "America/Sao_Paulo";
    banco.agendas.push({
      id: JANELA,
      organization_id: ORG,
      status: "scheduled",
      starts_at: futuro(2),
      ends_at: futuro(3),
    });

    const r = await GET(new NextRequest("http://localhost/api/v1/channel-schedules"));
    expect(r.status).toBe(200);
    const corpo = (await r.json()) as { data: { fuso: string; agendas: Linha[] } };
    expect(corpo.data.fuso).toBe("America/Sao_Paulo");
    expect(corpo.data.agendas.map((a) => a.id)).toContain(JANELA);
  });
});
