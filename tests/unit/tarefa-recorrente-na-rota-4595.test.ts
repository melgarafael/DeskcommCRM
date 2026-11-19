/**
 * A SÉRIE QUE SE REPETE (#4595) ATRAVESSA A ROTA FINA DO #4516.
 *
 * ─── Por que este arquivo existe ───────────────────────────────────────────
 *
 * O #4595 nasceu na main com a regra da série DENTRO de `app/api/v1/tasks/route.ts`
 * e de `app/api/v1/tasks/[id]/route.ts`. O #4516 tirou a regra das rotas para
 * `_handler.ts` — as duas rotas ficaram finas porque a tool MCP chama a MESMA
 * função. Na hora de juntar os dois, a série não podia voltar a morar na rota
 * (seria o segundo lugar de regra que o #4516 fechou) nem podia ser descartada
 * (a tarefa que se repete é comportamento publicado da main).
 *
 * A resolução de união foi: a FORMA (`recurrence` no schema zod) continua na
 * rota; a DECISÃO (normalizar a regra, calcular a primeira ocorrência no fuso da
 * organização, desligar com `null`) foi para `_handler.ts`.
 *
 * Este arquivo é a prova de que os DOIS lados continuam de pé, pela rota:
 *
 *  • se a rota perder `recurrence` do schema, o zod descarta o campo em silêncio
 *    e a tarefa é criada como avulsa — o caso do `dias: []` passa a devolver 201
 *    em vez de 422, e o caso do `null` no PATCH deixa de zerar a série;
 *  • se o handler perder a normalização, o JSON torto chega ao banco cru;
 *  • se o cálculo da primeira ocorrência voltar a ser em UTC, a hora de parede
 *    lida no fuso da organização deixa de ser 9.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { partesNoFuso } from "@/lib/agenda/fuso";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { portaDaAplicacao } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => true,
}));
vi.mock("@/lib/tarefas/atividade", () => ({
  registraAtividadeDaTarefa: vi.fn(async () => undefined),
}));
vi.mock("@/lib/tarefas/demanda", () => ({ conferirDemanda: vi.fn(async () => "ok") }));
vi.mock("@/lib/tarefas/responsavel", () => ({ conferirResponsavel: vi.fn(async () => "ok") }));
vi.mock("@/lib/tarefas/negocio-da-tarefa", () => ({
  COLUNAS_DA_TAREFA: "*",
  anexarNegocioDaTarefa: vi.fn(async (_db: unknown, _org: string, tarefas: unknown[]) => tarefas),
  conferirNegocioEContato: vi.fn(async () => "aceitos"),
}));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  portaDaAplicacao: vi.fn(),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const TAREFA = "55555555-5555-4555-8555-555555555555";
const FUSO = "America/Sao_Paulo";
const ctx = { params: Promise.resolve({ id: TAREFA }) };

type Payload = Record<string, unknown>;

function sessao(papel: Role = "agent") {
  const user: AuthUser = {
    id: ANA,
    email: "ana@example.com",
    full_name: "Ana",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: papel }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK[papel] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId: ORG, name: "Org", role: papel } }
      : { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) },
  );
}

const LINHA = {
  id: TAREFA,
  organization_id: ORG,
  title: "Ligar para a carteira",
  description: null,
  due_date: null,
  priority: "medium",
  status: "pending",
  lead_id: null,
  contact_id: null,
  demanda_id: null,
  assigned_to: null,
  created_by: ANA,
  recurrence: null,
  created_at: "2026-11-15T10:00:00.000Z",
  updated_at: "2026-11-15T10:00:00.000Z",
  lead: null,
};

/**
 * Dublê do PostgREST que ANOTA o corpo do INSERT e do UPDATE.
 *
 * É o que importa aqui: o que a série grava, não o que a resposta devolve.
 */
function duplo() {
  const registro: { inserts: Payload[]; updates: Payload[] } = { inserts: [], updates: [] };
  let operacao: "select" | "insert" | "update" | "delete" = "select";
  let corpo: Payload | undefined;

  const resultado = () => {
    if (operacao === "insert" || operacao === "update") {
      return { data: { ...LINHA, ...corpo }, error: null };
    }
    // A leitura do "antes" no PATCH (#4028): só a coluna `status` é pedida.
    return { data: { status: "pending" }, error: null };
  };

  const from = () => {
    const elo: Record<string, unknown> = {};
    elo.insert = (p: Payload) => {
      operacao = "insert";
      corpo = p;
      registro.inserts.push(p);
      return elo;
    };
    elo.update = (p: Payload) => {
      operacao = "update";
      corpo = p;
      registro.updates.push(p);
      return elo;
    };
    elo.delete = () => {
      operacao = "delete";
      return elo;
    };
    for (const metodo of ["select", "order", "limit", "is", "in", "eq"] as const) {
      elo[metodo] = () => elo;
    }
    elo.single = async () => resultado();
    elo.maybeSingle = async () => resultado();
    elo.then = (res: (v: unknown) => unknown) => Promise.resolve(resultado()).then(res);
    return elo;
  };

  return { client: { from }, registro };
}

function montar() {
  const d = duplo();
  vi.mocked(createClient).mockResolvedValue(d.client as never);
  return d;
}

function post(corpo: Payload) {
  return new NextRequest("http://x/api/v1/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

function patch(corpo: Payload) {
  return new NextRequest(`http://x/api/v1/tasks/${TAREFA}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

/** Dia da semana LOCAL a partir das partes lidas no fuso. */
function diaDaSemana(partes: { ano: number; mes: number; dia: number }): number {
  return new Date(Date.UTC(partes.ano, partes.mes - 1, partes.dia)).getUTCDay();
}

beforeEach(() => {
  vi.clearAllMocks();
  sessao();
  vi.mocked(portaDaAplicacao).mockReturnValue({
    async query() {
      return [{ timezone: FUSO }];
    },
    async queryOne() {
      return null as never;
    },
  } as never);
});

describe("POST /api/v1/tasks com `recurrence` — a série criada pela rota (#4595)", () => {
  it("⭐ grava a regra normalizada e a primeira ocorrência no fuso da organização", async () => {
    const d = montar();
    const { POST } = await import("@/app/api/v1/tasks/route");

    const res = await POST(post({ title: "Ligar para a carteira", recurrence: { dias: [1], hora: 9 } }));

    expect(res.status).toBe(201);
    expect(d.registro.inserts).toHaveLength(1);
    const inserido = d.registro.inserts[0]!;

    // `ativa` explícita: a tela não deve adivinhar o padrão do banco.
    expect(inserido.recurrence).toEqual({ dias: [1], hora: 9, ativa: true });

    // A hora é de PAREDE no fuso da organização — em UTC cru seriam 9h UTC,
    // que é 6h em São Paulo.
    const due = new Date(inserido.due_date as string);
    const partes = partesNoFuso(due, FUSO);
    expect(partes.hora).toBe(9);
    expect(diaDaSemana(partes)).toBe(1);
    expect(due.getTime()).toBeGreaterThan(Date.now());
  });

  it("regra sem dia nenhum é 422 nomeado — e NADA é inserido", async () => {
    const d = montar();
    const { POST } = await import("@/app/api/v1/tasks/route");

    const res = await POST(post({ title: "Sem dia", recurrence: { dias: [], hora: 9 } }));

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error?: { code?: string } };
    expect(corpo.error?.code).toBe("validation_failed");
    expect(d.registro.inserts).toEqual([]);
  });

  it("tarefa sem `recurrence` continua avulsa (regressão do caminho de antes)", async () => {
    const d = montar();
    const { POST } = await import("@/app/api/v1/tasks/route");

    const res = await POST(post({ title: "Avulsa", due_date: "2026-12-01T12:00:00.000Z" }));

    expect(res.status).toBe(201);
    const inserido = d.registro.inserts[0]!;
    expect(inserido.recurrence).toBeNull();
    expect(inserido.due_date).toBe("2026-12-01T12:00:00.000Z");
  });
});

describe("PATCH /api/v1/tasks/[id] com `recurrence` — a série editada pela rota (#4595)", () => {
  it("⭐ `null` DESLIGA a repetição: o UPDATE leva `recurrence: null`", async () => {
    const d = montar();
    const { PATCH } = await import("@/app/api/v1/tasks/[id]/route");

    const res = await PATCH(patch({ recurrence: null }), ctx);

    expect(res.status).toBe(200);
    expect(d.registro.updates).toHaveLength(1);
    expect(d.registro.updates[0]!.recurrence).toBeNull();
  });

  it("a regra editada é normalizada (dias ordenados, sem repetido, `ativa` explícita)", async () => {
    const d = montar();
    const { PATCH } = await import("@/app/api/v1/tasks/[id]/route");

    const res = await PATCH(patch({ recurrence: { dias: [3, 1, 3], hora: 7 } }), ctx);

    expect(res.status).toBe(200);
    expect(d.registro.updates[0]!.recurrence).toEqual({ dias: [1, 3], hora: 7, ativa: true });
  });
});
