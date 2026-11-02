/**
 * POST /api/v1/contacts/:id/roteiros/:enrollmentId/negocio (#3363) — a escolha
 * do card é HUMANA e PRIMEIRO-VENCE. Esta rota é a única porta em que a equipe
 * troca a "seleção pelo último card editado" por um destino explícito; o que os
 * testes guardam: nada de sobrescrever um vínculo existente (trocar o destino no
 * meio é o redirecionamento vedado) e nada de escolher card que não é daquele
 * contato ou que já está fechado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({
  role: vi.fn(),
  client: vi.fn(),
  modulo: vi.fn(),
  suporte: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.suporte }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: deps.modulo }));

import { POST } from "./route";

const CONTATO = "11111111-1111-4111-8111-111111111111";
const ENROLLMENT = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const ctx = { params: Promise.resolve({ id: CONTATO, enrollmentId: ENROLLMENT }) };
const req = (corpo: unknown = { lead_id: LEAD }) =>
  new NextRequest(`http://localhost/api/v1/contacts/${CONTATO}/roteiros/${ENROLLMENT}/negocio`, {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });

interface Inserido {
  [k: string]: unknown;
}

function cadeia(resultado: unknown) {
  const c = {
    select: () => c,
    eq: () => c,
    order: () => c,
    limit: () => c,
    maybeSingle: async () => resultado,
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resultado).then(res, rej),
  };
  return c;
}

function cliente(opts: {
  enrollment?: unknown;
  lead?: unknown;
  vinculo?: unknown;
  erroDoInsert?: { code?: string; message: string } | null;
  inseridos?: Inserido[];
}) {
  const inseridos = opts.inseridos ?? [];
  return {
    from: (tabela: string) => {
      if (tabela === "followup_enrollments") return cadeia({ data: opts.enrollment ?? null, error: null });
      if (tabela === "crm_leads") return cadeia({ data: opts.lead ?? null, error: null });
      if (tabela === "followup_enrollment_events") {
        return {
          ...cadeia({ data: opts.vinculo ?? null, error: null }),
          insert: async (linha: Inserido) => {
            inseridos.push(linha);
            return { data: null, error: opts.erroDoInsert ?? null };
          },
        };
      }
      return cadeia({ data: null, error: null });
    },
  };
}

const enrollmentVivo = { id: ENROLLMENT, status: "coletando", contact_id: CONTATO };
const leadAberto = { id: LEAD, status: "open", contact_id: CONTATO };

beforeEach(() => {
  vi.clearAllMocks();
  deps.modulo.mockResolvedValue(true);
  deps.suporte.mockResolvedValue(null);
  deps.role.mockResolvedValue({
    ok: true,
    user: { id: "eu", idioma: "pt-BR" },
    org: { orgId: "org", role: "manager" },
  });
});

describe("POST .../roteiros/:enrollmentId/negocio", () => {
  it("acompanhamento em modo leitura: a guarda de efeito recusa antes do RBAC", async () => {
    deps.suporte.mockResolvedValue(new Response(null, { status: 403 }));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
    expect(deps.role).not.toHaveBeenCalled();
    expect(deps.client).not.toHaveBeenCalled();
  });

  it("módulo desligado: 404 e o banco nem é tocado", async () => {
    deps.modulo.mockResolvedValue(false);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
    expect(deps.client).not.toHaveBeenCalled();
  });

  it("lead_id que não é uuid: 400", async () => {
    const res = await POST(req({ lead_id: "lead-1" }), ctx);
    expect(res.status).toBe(400);
  });

  it("roteiro de OUTRO contato não existe por aqui: 404", async () => {
    deps.client.mockResolvedValue(cliente({ enrollment: null }));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
  });

  it("execução já encerrada: 409 (a próxima resolve de novo)", async () => {
    deps.client.mockResolvedValue(
      cliente({ enrollment: { ...enrollmentVivo, status: "completed" } }),
    );
    const res = await POST(req(), ctx);
    expect(res.status).toBe(409);
  });

  it("card fechado, ou de outro contato, não é escolha válida: 422", async () => {
    deps.client.mockResolvedValue(
      cliente({ enrollment: enrollmentVivo, lead: { ...leadAberto, status: "won" } }),
    );
    expect((await POST(req(), ctx)).status).toBe(422);

    deps.client.mockClear();
    deps.client.mockResolvedValue(
      cliente({ enrollment: enrollmentVivo, lead: { ...leadAberto, contact_id: "outro" } }),
    );
    expect((await POST(req(), ctx)).status).toBe(422);
  });

  it("PRIMEIRO VENCE: com vínculo já gravado, devolve o existente e NÃO regrava", async () => {
    const inseridos: Inserido[] = [];
    deps.client.mockResolvedValue(
      cliente({
        enrollment: enrollmentVivo,
        lead: leadAberto,
        vinculo: { payload: { lead_id: "44444444-4444-4444-8444-444444444444" } },
        inseridos,
      }),
    );
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { lead_id: "44444444-4444-4444-8444-444444444444" },
    });
    expect(inseridos).toHaveLength(0);
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("grava o vínculo na TRILHA da execução, com chave fixa e só o lead_id", async () => {
    const inseridos: Inserido[] = [];
    deps.client.mockResolvedValue(
      cliente({ enrollment: enrollmentVivo, lead: leadAberto, vinculo: null, inseridos }),
    );
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { lead_id: LEAD } });
    expect(inseridos).toEqual([
      {
        organization_id: "org",
        enrollment_id: ENROLLMENT,
        node_id: null,
        event_type: "roteiro_negocio",
        payload: { lead_id: LEAD },
        idempotency_key: "roteiro_negocio",
      },
    ]);
    // A autoria de quem escolheu mora no log de auditoria — a trilha não tem autor.
    expect(deps.audit).toHaveBeenCalledTimes(1);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "followup_enrollment.negocio_escolhido",
        actorUserId: "eu",
        organizationId: "org",
        resourceId: ENROLLMENT,
        metadata: { lead_id: LEAD, contact_id: CONTATO },
      }),
    );
  });

  it("corrida no insert (23505): a resposta é o vínculo do primeiro, não um erro", async () => {
    deps.client.mockResolvedValue(
      cliente({
        enrollment: enrollmentVivo,
        lead: leadAberto,
        vinculo: null,
        erroDoInsert: { code: "23505", message: "duplicate key" },
      }),
    );
    const res = await POST(req(), ctx);
    // Sem vínculo legível depois do conflito, o honesto é 200 com o pedido:
    // quem relê a ficha vê o card que de fato ficou gravado.
    expect(res.status).toBe(200);
  });
});
