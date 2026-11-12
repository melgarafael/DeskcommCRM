// @vitest-environment node
/**
 * Token de integração nas regras de automação e nos horários de atendimento
 * (Spec 33, fatia R1, Task 11).
 *
 * Métodos convertidos, por rota:
 *  - automation-rules GET (lista), automation-rules/[id]/runs GET,
 *    automation-rules/runs GET: receita A (manager; config:read; tokenRole admin).
 *  - automation-rules/[id] DELETE: receita A (manager; config:write; tokenRole admin).
 *  - channel-schedules GET/POST, channel-schedules/[id] PATCH/DELETE: receita B
 *    (admin; a sessão segue o portão de sempre, com `allowPlatformAdmin`, que
 *    `resolveAuthDual` não repassa).
 *
 *  - automation-rules POST: receita A (manager; config:write; tokenRole admin). Só o ramo do
 *    token confere os ids que a regra carrega (`lib/automation/validar-ids-das-acoes.ts`).
 *
 * Fica só de sessão (token recebe 401 do `requireRole`, sem cliente admin):
 *  - automation-rules/[id] PATCH: a autoria usa `authz.org.role`.
 *
 * Por caso, sete testes: token de A alcança; token de B não alcança; sem o
 * escopo; abaixo do papel; acima do teto do token; acima do teto da organização;
 * sessão continua com o mesmo portão.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { isPublicPath } from "@/lib/auth/public-paths";
import type { Role } from "@/lib/auth/types";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  linhasDaTabela,
  rpcsForaDaOrganizacao,
} from "@/tests/unit/helpers/cliente-admin-falso";

import * as rotaRegras from "@/app/api/v1/automation-rules/route";
import * as rotaRegra from "@/app/api/v1/automation-rules/[id]/route";
import * as rotaRegraRuns from "@/app/api/v1/automation-rules/[id]/runs/route";
import * as rotaRuns from "@/app/api/v1/automation-rules/runs/route";
import * as rotaHorarios from "@/app/api/v1/channel-schedules/route";
import * as rotaHorario from "@/app/api/v1/channel-schedules/[id]/route";

vi.mock("@/lib/auth/require-role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/require-role")>()),
  requireRole: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/mcp/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/auth")>()),
  validateBearerToken: vi.fn(),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

// ---------------------------------------------------------------------------
// Fixtures — declaradas antes do uso
// ---------------------------------------------------------------------------

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const TODOS_OS_ESCOPOS = ["config:read", "config:write"];
const MENSAGEM_DO_CLIENTE_DE_SESSAO = "cliente de sessão usado no ramo do token";

const REGRA_A = "11111111-1111-4111-8111-111111111111";
const REGRA_B = "22222222-2222-4222-8222-222222222222";
const EXEC_A = "33333333-3333-4333-8333-333333333333";
const EXEC_B = "44444444-4444-4444-8444-444444444444";
/** Execução DE A cujo `rule_id` aponta para uma regra DE B (linha que não deve vazar o nome). */
const EXEC_CRUZADA = "99999999-9999-4999-8999-999999999999";
const JANELA_A = "55555555-5555-4555-8555-555555555555";
const JANELA_B = "66666666-6666-4666-8666-666666666666";
const CANAL_A = "77777777-7777-4777-8777-777777777777";
const CANAL_B = "88888888-8888-4888-8888-888888888888";
const FUNIL_A = "a7a7a7a7-a7a7-4a7a-8a7a-a7a7a7a7a7a7";
const ETAPA_A = "a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a8a8";

/**
 * Todas as tabelas desta área têm `organization_id` no baseline
 * (`automation_rules`, `automation_rule_runs`, `channel_schedules`,
 * `channel_sessions`). `organizations` é tratada pelo dublê pela coluna `id`.
 */
const SEM_ORGANIZACAO = [] as const;
const OPCOES = { tabelasSemOrganizacao: SEM_ORGANIZACAO } as const;

/** Horário em torno de agora: a régua de janela exige início futuro e até 24h. */
function futuro(horas: number): string {
  return new Date(Date.now() + horas * 3_600_000).toISOString();
}

function regra(org: string, id: string, nome: string) {
  return {
    id,
    organization_id: org,
    name: nome,
    trigger_event: "lead.created",
    conditions: [],
    actions: [],
    is_active: false,
    trigger_config: {},
    run_count: 0,
    last_run_at: null,
    created_by_user_id: null,
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-01T10:00:00Z",
  };
}

function execucao(org: string, id: string, ruleId: string) {
  return {
    id,
    organization_id: org,
    rule_id: ruleId,
    event_id: null,
    status: "success",
    actions_result: [],
    error: null,
    created_at: "2026-10-02T10:00:00Z",
  };
}

function janela(org: string, id: string, canal: string | null) {
  return {
    id,
    organization_id: org,
    channel_session_id: canal,
    starts_at: futuro(5),
    ends_at: futuro(6),
    status: "scheduled",
    paused_channel_ids: [],
    created_by: null,
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-01T10:00:00Z",
  };
}

/** Linhas das DUAS organizações: o dublê precisa ver as duas para acusar vazamento. */
const LINHAS = {
  automation_rules: [regra(ORG_A, REGRA_A, "Regra de A"), regra(ORG_B, REGRA_B, "Regra de B")],
  automation_rule_runs: [
    execucao(ORG_A, EXEC_A, REGRA_A),
    execucao(ORG_B, EXEC_B, REGRA_B),
    execucao(ORG_A, EXEC_CRUZADA, REGRA_B),
  ],
  channel_schedules: [janela(ORG_A, JANELA_A, null), janela(ORG_B, JANELA_B, null)],
  channel_sessions: [
    { id: CANAL_A, organization_id: ORG_A, archived_at: null },
    { id: CANAL_B, organization_id: ORG_B, archived_at: null },
  ],
  crm_pipelines: [{ id: FUNIL_A, organization_id: ORG_A, settings: {} }],
  crm_stages: [{ id: ETAPA_A, organization_id: ORG_A, pipeline_id: FUNIL_A }],
  organizations: [
    { id: ORG_A, timezone: "America/Sao_Paulo" },
    { id: ORG_B, timezone: "Europe/London" },
  ],
};

function novoFalso() {
  return criarClienteAdminFalso({ orgDona: ORG_A, linhas: LINHAS, tabelasSemOrganizacao: SEM_ORGANIZACAO });
}

let falso: ReturnType<typeof novoFalso>;

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

function tokenDe(org: string, token: string, role: Role, scopes: string[] = TODOS_OS_ESCOPOS): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: org,
    role,
    actor: { type: "api_token", id: token, role },
    apiTokenId: token,
    scopes,
  } as never);
}

function req(metodo: string, caminho: string, token?: string, corpo?: unknown): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const init: NonNullable<ConstructorParameters<typeof NextRequest>[1]> = { method: metodo, headers };
  if (corpo !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(corpo);
  }
  return new NextRequest(`http://localhost${caminho}`, init);
}

function comId(id: string) {
  return { params: Promise.resolve({ id }) };
}

function corpoJanela(canal: string) {
  return { starts_at: futuro(3), ends_at: futuro(4), channel_session_id: canal };
}

async function lerJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function idsDe(lista: Array<{ id: string }>): string[] {
  return lista.map((linha) => linha.id);
}

type Recurso = "A" | "B";

type Cfg = {
  metodo: "GET" | "POST" | "PATCH" | "DELETE";
  /** `resource` que a rota passa ao `requireRole` (a sessão). */
  recurso: string;
  /** Papel da tabela (o que a sessão exige). */
  papel: Role;
  escopo: "config:read" | "config:write";
  /** Prefixo do balde de teto da rota (`${recursoDoTeto}:tok:…` e `:org:…`). */
  recursoDoTeto: string;
  /** `allowPlatformAdmin` que a rota passa ao `requireRole` na sessão (só horários). */
  plataforma?: true | "leitura";
  /** Chama o handler. `de` é o recurso que a chamada pede: "A" ou "B". */
  chamar: (token: string | undefined, de: Recurso) => Promise<Response>;
  /** Asserções do token de A: 2xx e o que a resposta mostra. */
  alcanca: (res: Response) => Promise<void>;
  /** Asserções do token de B pedindo o recurso de A: 404, ou lista sem A. */
  naoAlcanca: (res: Response) => Promise<void>;
};

/** Os sete testes de um caso (uma linha da tabela do plano). */
function caso(rotulo: string, cfg: Cfg): void {
  describe(rotulo, () => {
    const escopoOposto = cfg.escopo === "config:read" ? "config:write" : "config:read";

    it(`${cfg.metodo}: token de A alcança o recurso de A`, async () => {
      tokenDe(ORG_A, TOKEN_A, "admin");
      const res = await cfg.chamar(TOKEN_A, "A");
      await cfg.alcanca(res);
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A, OPCOES)).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
    });

    it(`${cfg.metodo}: token de B não alcança o recurso de A`, async () => {
      tokenDe(ORG_B, TOKEN_B, "admin");
      const res = await cfg.chamar(TOKEN_B, "A");
      await cfg.naoAlcanca(res);
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B, OPCOES)).toEqual([]);
      if (cfg.metodo !== "GET") expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    });

    it(`${cfg.metodo}: token sem o escopo exigido é recusado (403)`, async () => {
      tokenDe(ORG_A, TOKEN_A, "admin", [escopoOposto]);
      const res = await cfg.chamar(TOKEN_A, "A");
      expect(res.status).toBe(403);
      expect(falso.cadeias).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });

    it(`${cfg.metodo}: token abaixo do papel é recusado (403)`, async () => {
      tokenDe(ORG_A, TOKEN_A, "manager");
      const res = await cfg.chamar(TOKEN_A, "A");
      expect(res.status).toBe(403);
      expect(falso.cadeias).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });

    it(`${cfg.metodo}: acima do teto do token → 429 com Retry-After, sem tocar no banco`, async () => {
      vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, count: 31, limit: 30 } as never);
      tokenDe(ORG_A, TOKEN_A, "admin");
      const res = await cfg.chamar(TOKEN_A, "A");
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect(vi.mocked(checkRateLimit).mock.calls[0]?.[0]).toBe(`${cfg.recursoDoTeto}:tok:${TOKEN_A}`);
      expect(falso.cadeias).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });

    it(`${cfg.metodo}: acima do teto da organização → 429 com Retry-After, sem tocar no banco`, async () => {
      // Teto do token passa (1ª chamada); o da organização recusa (2ª chamada).
      vi.mocked(checkRateLimit)
        .mockResolvedValueOnce({ allowed: true, count: 1, limit: 30 } as never)
        .mockResolvedValueOnce({ allowed: false, count: 301, limit: 300 } as never);
      tokenDe(ORG_A, TOKEN_A, "admin");
      const res = await cfg.chamar(TOKEN_A, "A");
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect((await lerJson<{ error: { code: string } }>(res)).error.code).toBe("rate_limited");
      expect(vi.mocked(checkRateLimit).mock.calls[1]?.[0]).toBe(`${cfg.recursoDoTeto}:org:${ORG_A}`);
      expect(falso.cadeias).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });

    it(`${cfg.metodo}: sessão continua com o mesmo portão (requireRole com o papel da tabela)`, async () => {
      vi.mocked(requireRole).mockResolvedValueOnce({
        ok: false,
        response: new Response(null, { status: 401 }),
      } as never);
      const res = await cfg.chamar(undefined, "A");
      expect(res.status).toBe(401);
      expect(requireRole).toHaveBeenCalledWith(
        cfg.papel,
        expect.objectContaining({
          resource: cfg.recurso,
          ...(cfg.plataforma !== undefined ? { allowPlatformAdmin: cfg.plataforma } : {}),
        }),
      );
      expect(validateBearerToken).not.toHaveBeenCalled();
      expect(falso.cadeias).toEqual([]);
    });
  });
}

// ---------------------------------------------------------------------------
// Casos
// ---------------------------------------------------------------------------

caso("GET /api/v1/automation-rules (lista)", {
  metodo: "GET",
  recurso: "automation_rules",
  papel: "manager",
  escopo: "config:read",
  recursoDoTeto: "automation_rules_lista",
  chamar: (token) => rotaRegras.GET(req("GET", "/api/v1/automation-rules", token)),
  alcanca: async (res) => {
    expect(res.status).toBe(200);
    const ids = idsDe((await lerJson<{ data: Array<{ id: string }> }>(res)).data);
    expect(ids).toContain(REGRA_A);
    expect(ids).not.toContain(REGRA_B);
  },
  naoAlcanca: async (res) => {
    expect(res.status).toBe(200);
    const ids = idsDe((await lerJson<{ data: Array<{ id: string }> }>(res)).data);
    expect(ids).not.toContain(REGRA_A);
  },
});

caso("DELETE /api/v1/automation-rules/[id]", {
  metodo: "DELETE",
  recurso: "automation_rules",
  papel: "manager",
  escopo: "config:write",
  recursoDoTeto: "automation_rules_item",
  chamar: (token) => rotaRegra.DELETE(req("DELETE", `/api/v1/automation-rules/${REGRA_A}`, token), comId(REGRA_A)),
  alcanca: async (res) => {
    expect(res.status).toBe(204);
    expect(idsDe(falso.linhas.automation_rules as Array<{ id: string }>)).not.toContain(REGRA_A);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "automation.rule_deleted",
        organizationId: ORG_A,
        actorUserId: null,
        actorApiTokenId: TOKEN_A,
        resourceId: REGRA_A,
      }),
    );
  },
  naoAlcanca: async (res) => {
    expect(res.status).toBe(404);
    expect(idsDe(falso.linhas.automation_rules as Array<{ id: string }>)).toContain(REGRA_A);
    expect(audit).not.toHaveBeenCalled();
  },
});

caso("POST /api/v1/automation-rules", {
  metodo: "POST",
  recurso: "automation_rules",
  papel: "manager",
  escopo: "config:write",
  recursoDoTeto: "automation_rules",
  chamar: (token, de) =>
    rotaRegras.POST(
      req("POST", "/api/v1/automation-rules", token, {
        name: "Regra nova",
        trigger_event: "lead.created",
        actions: [
          {
            type: "send_whatsapp_message",
            config: { channel_session_id: de === "A" ? CANAL_A : CANAL_B, template: "Oi" },
          },
        ],
      }),
    ),
  alcanca: async (res) => {
    expect(res.status).toBe(201);
    const criada = linhasDaTabela(falso, "automation_rules").find((l) => l.name === "Regra nova");
    expect(criada?.organization_id).toBe(ORG_A);
    expect(criada?.created_by_user_id).toBeNull();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "automation.rule_created",
        organizationId: ORG_A,
        actorUserId: null,
        actorApiTokenId: TOKEN_A,
      }),
    );
  },
  // Token de B apontando para o canal de A: o validador recusa e nada é gravado.
  naoAlcanca: async (res) => {
    expect(res.status).toBe(422);
    expect(linhasDaTabela(falso, "automation_rules").some((l) => l.name === "Regra nova")).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  },
});

caso("GET /api/v1/automation-rules/[id]/runs", {
  metodo: "GET",
  recurso: "automation_rules",
  papel: "manager",
  escopo: "config:read",
  recursoDoTeto: "automation_rules_runs_da_regra",
  chamar: (token) =>
    rotaRegraRuns.GET(req("GET", `/api/v1/automation-rules/${REGRA_A}/runs`, token), comId(REGRA_A)),
  alcanca: async (res) => {
    expect(res.status).toBe(200);
    const ids = idsDe((await lerJson<{ data: Array<{ id: string }> }>(res)).data);
    expect(ids).toContain(EXEC_A);
    expect(ids).not.toContain(EXEC_B);
  },
  naoAlcanca: async (res) => {
    expect(res.status).toBe(200);
    const ids = idsDe((await lerJson<{ data: Array<{ id: string }> }>(res)).data);
    expect(ids).not.toContain(EXEC_A);
  },
});

caso("GET /api/v1/automation-rules/runs (atividade da organização)", {
  metodo: "GET",
  recurso: "automation_rules",
  papel: "manager",
  escopo: "config:read",
  recursoDoTeto: "automation_rules_runs_da_org",
  chamar: (token) => rotaRuns.GET(req("GET", "/api/v1/automation-rules/runs?limit=50", token)),
  alcanca: async (res) => {
    expect(res.status).toBe(200);
    const linhas = (
      await lerJson<{ data: Array<{ id: string; automation_rules: { name: string } | null }> }>(res)
    ).data;
    expect(idsDe(linhas)).toContain(EXEC_A);
    expect(idsDe(linhas)).not.toContain(EXEC_B);
    // O nome vem da regra DESTA organização, pela consulta própria do ramo de token.
    expect(linhas.find((l) => l.id === EXEC_A)?.automation_rules?.name).toBe("Regra de A");
    // Execução de A apontando para regra de B: a linha aparece, mas o nome NÃO sai
    // (a consulta de nomes filtra a organização, e a regra de B não é desta org).
    expect(idsDe(linhas)).toContain(EXEC_CRUZADA);
    expect(linhas.find((l) => l.id === EXEC_CRUZADA)?.automation_rules).toBeNull();
  },
  naoAlcanca: async (res) => {
    expect(res.status).toBe(200);
    const linhas = (
      await lerJson<{ data: Array<{ id: string; automation_rules: { name: string } | null }> }>(res)
    ).data;
    expect(idsDe(linhas)).not.toContain(EXEC_A);
    expect(idsDe(linhas)).not.toContain(EXEC_CRUZADA);
    expect(linhas.some((l) => l.automation_rules?.name === "Regra de A")).toBe(false);
  },
});

caso("GET /api/v1/channel-schedules (janelas e fuso)", {
  metodo: "GET",
  recurso: "channel_schedules",
  papel: "admin",
  escopo: "config:read",
  recursoDoTeto: "channel_schedules_leitura",
  plataforma: "leitura",
  chamar: (token) => rotaHorarios.GET(req("GET", "/api/v1/channel-schedules", token)),
  alcanca: async (res) => {
    expect(res.status).toBe(200);
    const corpo = await lerJson<{ data: { fuso: string; agendas: Array<{ id: string }> } }>(res);
    expect(corpo.data.fuso).toBe("America/Sao_Paulo");
    expect(idsDe(corpo.data.agendas)).toContain(JANELA_A);
    expect(idsDe(corpo.data.agendas)).not.toContain(JANELA_B);
  },
  naoAlcanca: async (res) => {
    expect(res.status).toBe(200);
    const corpo = await lerJson<{ data: { fuso: string; agendas: Array<{ id: string }> } }>(res);
    expect(corpo.data.fuso).toBe("Europe/London");
    expect(idsDe(corpo.data.agendas)).not.toContain(JANELA_A);
  },
});

caso("POST /api/v1/channel-schedules (criar janela)", {
  metodo: "POST",
  recurso: "channel_schedules",
  papel: "admin",
  escopo: "config:write",
  recursoDoTeto: "channel_schedules",
  plataforma: true,
  chamar: (token, de) =>
    rotaHorarios.POST(
      req("POST", "/api/v1/channel-schedules", token, corpoJanela(de === "A" ? CANAL_A : CANAL_B)),
    ),
  alcanca: async (res) => {
    expect(res.status).toBe(200);
    const corpo = await lerJson<{ data: { agenda: { organization_id: string; created_by: string | null } } }>(res);
    expect(corpo.data.agenda.organization_id).toBe(ORG_A);
    expect(corpo.data.agenda.created_by).toBeNull();
    expect(falso.linhas.channel_schedules).toHaveLength(3);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.schedule_created",
        organizationId: ORG_A,
        actorUserId: null,
        actorApiTokenId: TOKEN_A,
      }),
    );
  },
  naoAlcanca: async (res) => {
    // O canal pedido é de A: para B ele não existe (404), e nada é gravado.
    expect(res.status).toBe(404);
    expect(falso.linhas.channel_schedules).toHaveLength(2);
    expect(audit).not.toHaveBeenCalled();
  },
});

caso("PATCH /api/v1/channel-schedules/[id] (editar horário)", {
  metodo: "PATCH",
  recurso: "channel_schedules",
  papel: "admin",
  escopo: "config:write",
  recursoDoTeto: "channel_schedules_editar",
  plataforma: true,
  chamar: (token) =>
    rotaHorario.PATCH(
      req("PATCH", `/api/v1/channel-schedules/${JANELA_A}`, token, { starts_at: futuro(5), ends_at: futuro(6) }),
      comId(JANELA_A),
    ),
  alcanca: async (res) => {
    expect(res.status).toBe(200);
    const corpo = await lerJson<{ data: { mudou: boolean } }>(res);
    expect(corpo.data.mudou).toBe(true);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.schedule_updated",
        organizationId: ORG_A,
        actorUserId: null,
        actorApiTokenId: TOKEN_A,
        resourceId: JANELA_A,
      }),
    );
  },
  naoAlcanca: async (res) => {
    expect(res.status).toBe(404);
    expect(audit).not.toHaveBeenCalled();
  },
});

caso("DELETE /api/v1/channel-schedules/[id] (cancelar janela)", {
  metodo: "DELETE",
  recurso: "channel_schedules",
  papel: "admin",
  escopo: "config:write",
  recursoDoTeto: "channel_schedules_cancelar",
  plataforma: true,
  chamar: (token) => rotaHorario.DELETE(req("DELETE", `/api/v1/channel-schedules/${JANELA_A}`, token), comId(JANELA_A)),
  alcanca: async (res) => {
    expect(res.status).toBe(200);
    const corpo = await lerJson<{ data: { status: string; mudou: boolean } }>(res);
    expect(corpo.data.status).toBe("cancelled");
    expect(corpo.data.mudou).toBe(true);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.schedule_cancelled",
        organizationId: ORG_A,
        actorUserId: null,
        actorApiTokenId: TOKEN_A,
        resourceId: JANELA_A,
      }),
    );
  },
  naoAlcanca: async (res) => {
    expect(res.status).toBe(404);
    expect(linhasDaTabela(falso, "channel_schedules").find((l) => l.id === JANELA_A)?.status).toBe("scheduled");
    expect(audit).not.toHaveBeenCalled();
  },
});

// ---------------------------------------------------------------------------
// Métodos que ficam só de sessão
// ---------------------------------------------------------------------------

describe("POST /api/v1/automation-rules: ids que a regra carrega, só no ramo do token", () => {
  const corpoComEtapa = (pipeline: string, etapa: string) => ({
    name: "Regra nova",
    trigger_event: "lead.created",
    actions: [{ type: "create_or_move_lead", config: { pipeline_id: pipeline, stage_id: etapa } }],
  });
  const corpoComIa = (canal: string) => ({
    name: "Regra com IA",
    trigger_event: "lead.created",
    actions: [
      {
        type: "ai_decide",
        config: {
          custo_de_token: true,
          instrucao: "Escolha uma opção",
          opcoes: [
            { id: "a", rotulo: "Avisar", acao: { type: "notify_team", config: { canal: "whatsapp" } } },
            { id: "b", rotulo: "Enviar", acao: { type: "send_whatsapp_message", config: { channel_session_id: canal, template: "Oi" } } },
          ],
        },
      },
    ],
  });

  it("ação aninhada em ai_decide com canal de OUTRA organização → 422, e nada é gravado", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaRegras.POST(req("POST", "/api/v1/automation-rules", TOKEN_B, corpoComIa(CANAL_A)));
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("opcoes[1].acao.config.channel_session_id");
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("ação aninhada em ai_decide com canal da PRÓPRIA organização → 201", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaRegras.POST(req("POST", "/api/v1/automation-rules", TOKEN_A, corpoComIa(CANAL_A)));
    expect(res.status).toBe(201);
  });

  it("funil e etapa de OUTRA organização → 422", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaRegras.POST(
      req("POST", "/api/v1/automation-rules", TOKEN_B, corpoComEtapa(FUNIL_A, ETAPA_A)),
    );
    expect(res.status).toBe(422);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
  });

  it("a sessão não passa pelo validador: o ramo do token é o único que o chama", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: true,
      user: { id: "c0000000-0000-4000-8000-000000000001", idioma: "pt-BR" },
      org: { orgId: ORG_B, name: "B", role: "manager" },
    } as never);
    vi.mocked(createClient).mockResolvedValueOnce(falso.cliente as never);
    // Funil e etapa de A, numa sessão de B: a sessão confia na RLS e na tela (o dublê não modela
    // a RLS), então o validador NÃO roda e a regra é gravada. É o contrato: a sessão não muda.
    const res = await rotaRegras.POST(
      req("POST", "/api/v1/automation-rules", undefined, corpoComEtapa(FUNIL_A, ETAPA_A)),
    );
    expect(res.status).toBe(201);
    expect(validateBearerToken).not.toHaveBeenCalled();
  });
});

describe("fica só de sessão: o token recebe 401 e o cliente admin nunca é montado", () => {
  it("PATCH /api/v1/automation-rules/[id]: sem cookie, o requireRole responde 401 ao token", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 401 }),
    } as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaRegra.PATCH(
      req("PATCH", `/api/v1/automation-rules/${REGRA_A}`, TOKEN_A, { name: "Nova" }),
      comId(REGRA_A),
    );
    expect(res.status).toBe(401);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "automation_rules" }));
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(falso.cadeias).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bloco de borda das portas
// ---------------------------------------------------------------------------

describe("bloco de borda das portas", () => {
  it("automation-rules: coleção, runs e [id] com UUID entram; irmão literal e sub-path não", () => {
    expect(isPublicPath("/api/v1/automation-rules")).toBe(true);
    expect(isPublicPath(`/api/v1/automation-rules/${REGRA_A}`)).toBe(true);
    expect(isPublicPath(`/api/v1/automation-rules/${REGRA_A}/runs`)).toBe(true);
    expect(isPublicPath("/api/v1/automation-rules/runs")).toBe(true);
    expect(isPublicPath("/api/v1/automation-rules/abc")).toBe(false);
    expect(isPublicPath("/api/v1/automation-rules/abc/runs")).toBe(false);
    expect(isPublicPath(`/api/v1/automation-rules/${REGRA_A}/x`)).toBe(false);
    expect(isPublicPath(`/api/v1/automation-rules/runs/${EXEC_A}/resend`)).toBe(false);
  });

  it("channel-schedules: coleção e [id] com UUID entram; forma que não é UUID e sub-path não", () => {
    expect(isPublicPath("/api/v1/channel-schedules")).toBe(true);
    expect(isPublicPath(`/api/v1/channel-schedules/${JANELA_A}`)).toBe(true);
    expect(isPublicPath("/api/v1/channel-schedules/abc")).toBe(false);
    expect(isPublicPath(`/api/v1/channel-schedules/${JANELA_A}/x`)).toBe(false);
  });
});

beforeEach(() => {
  vi.resetAllMocks();
  falso = novoFalso();
  // Cliente admin do token: o dublê. Sem a sessão, o mesmo dublê não existe.
  vi.mocked(createAdminClient).mockImplementation(() => falso.cliente as never);
  // Tripwires: se o ramo de token tocar a sessão, a chamada quebra.
  vi.mocked(createClient).mockImplementation(async () => {
    throw new Error(MENSAGEM_DO_CLIENTE_DE_SESSAO);
  });
  vi.mocked(requireRole).mockImplementation(async () => {
    throw new Error("requireRole chamado no ramo do token");
  });
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, limit: 30 } as never);
});
