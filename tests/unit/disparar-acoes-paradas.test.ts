// @vitest-environment node
/**
 * O botão da Central que dispara o que a automação segurou no modo assistido
 * (doc 301 = B): `POST /api/v1/automation-rules/runs/[runId]/disparar`.
 *
 * Prende o contrato que importa para o cliente não receber nada em dobro nem
 * fora de hora: só as ações PARADAS daquele run saem; o aviso é a trava (o
 * segundo clique não dispara); fora da janela nada sai e o aviso reabre; regra
 * que mudou desde então não dispara a ação errada.
 *
 *     pnpm vitest run tests/unit/disparar-acoes-paradas.test.ts
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import type * as Engine from "@/lib/automation/engine";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/automation/actions/register-all", () => ({}));
vi.mock("@/lib/automation/engine", async (original) => ({
  ...(await original<typeof Engine>()),
  buildContext: vi.fn(async () => ({})),
}));

type Linha = Record<string, unknown>;
const banco: { tabelas: Record<string, Linha[]>; inserts: Array<{ tabela: string; linha: Linha }>; updates: Array<{ tabela: string; patch: Linha; filtros: Array<[string, unknown]> }> } = {
  tabelas: {},
  inserts: [],
  updates: [],
};

function cliente() {
  return {
    from(tabela: string) {
      const filtros: Array<[string, unknown]> = [];
      const listas: Array<[string, unknown[]]> = [];
      let patch: Linha | null = null;
      let inserida: Linha | null = null;
      const linhas = () =>
        (banco.tabelas[tabela] ?? []).filter(
          (l) => filtros.every(([c, v]) => l[c] === v) && listas.every(([c, vs]) => vs.includes(l[c])),
        );
      const resolver = () => {
        if (inserida) return { data: { id: "run-novo", ...inserida }, error: null };
        if (patch) {
          const alvo = linhas();
          banco.updates.push({ tabela, patch, filtros: [...filtros] });
          for (const l of alvo) Object.assign(l, patch);
          return { data: alvo.map((l) => ({ id: l.id })), error: null };
        }
        return { data: linhas(), error: null };
      };
      const q: Record<string, unknown> = {
        select: () => q,
        update: (p: Linha) => ((patch = p), q),
        insert: (l: Linha) => (banco.inserts.push({ tabela, linha: l }), (inserida = l), q),
        eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
        in: (c: string, vs: unknown[]) => (listas.push([c, vs]), q),
        maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
        single: async () => resolver(),
        then: (ok: (r: unknown) => unknown) => Promise.resolve(resolver()).then(ok),
      };
      return q;
    },
  };
}
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => cliente() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => cliente() }));

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { registerAction } from "@/lib/automation/actions";
import { MOTIVO_PARADA_NO_ASSISTIDO } from "@/lib/automation/parada-no-assistido";
import { POST } from "@/app/api/v1/automation-rules/runs/[runId]/disparar/route";

const ORG = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const REGRA = "44444444-4444-4444-8444-444444444444";
const usuario = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "gestora@clinica.com.br",
  full_name: "Gestão",
  avatar_url: null,
  is_platform_admin: false,
  idioma: "pt-BR" as const,
  organizations: [{ organization_id: ORG, organization_name: "Clínica", role: "manager" }],
} as AuthUser;
const orgAtiva: ActiveOrg = { orgId: ORG, name: "Clínica", role: "manager" };

const executadas: string[] = [];
let foraDaJanela = false;
/** Tipos cujo executor devolve `failed` (o envio não saiu), como o WhatsApp em `lead.won` medido na prova de tela. */
let falham: string[] = [];
/** Tipos cujo executor devolve `postponed`: a mensagem vai sair mais tarde. */
let adiam: string[] = [];
for (const tipo of ["add_tag", "send_whatsapp_message", "send_email"]) {
  registerAction({
    type: tipo,
    ...(tipo === "send_whatsapp_message"
      ? { postponeUntil: async () => (foraDaJanela ? "2099-01-01T10:00:00.000Z" : null) }
      : {}),
    async execute() {
      executadas.push(tipo);
      if (adiam.includes(tipo)) return { type: tipo, status: "postponed" };
      return falham.includes(tipo) ? { type: tipo, status: "failed", error: "internal_error" } : { type: tipo, status: "success" };
    },
  });
}

function mundo(acoesDaRegra = ["add_tag", "send_whatsapp_message", "send_email"]) {
  banco.inserts = [];
  banco.updates = [];
  banco.tabelas = {
    agent_inbox_items: [
      { id: "aviso-1", organization_id: ORG, kind: "other", ref_kind: "automation_rule_run", ref_id: RUN, status: "open" },
    ],
    automation_rule_runs: [
      {
        id: RUN,
        organization_id: ORG,
        rule_id: REGRA,
        event_id: "evt-1",
        contact_id: null,
        actions_result: [
          { type: "add_tag", status: "success" },
          { type: "send_whatsapp_message", status: "skipped", error: MOTIVO_PARADA_NO_ASSISTIDO },
          { type: "send_email", status: "skipped", error: MOTIVO_PARADA_NO_ASSISTIDO },
        ],
      },
    ],
    automation_rules: [
      { id: REGRA, organization_id: ORG, name: "Proposta enviada", actions: acoesDaRegra.map((type) => ({ type, config: {} })) },
    ],
    event_log: [{ id: "evt-1", organization_id: ORG, event_type: "lead.stage_changed", metadata: { actor_operation_mode: "assisted" } }],
  };
}

const clicar = () =>
  POST(new NextRequest(`https://crm.exemplo/api/v1/automation-rules/runs/${RUN}/disparar`, { method: "POST" }), {
    params: Promise.resolve({ runId: RUN }),
  });
const statusDoAviso = () => banco.tabelas.agent_inbox_items![0]!.status;

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: usuario, org: orgAtiva });
  vi.mocked(audit).mockClear();
  executadas.length = 0;
  foraDaJanela = false;
  falham = [];
  adiam = [];
  mundo();
});

describe("disparar o que ficou parado no assistido", () => {
  it("dispara SÓ as ações paradas, grava um run novo apontando para o parado e fecha o aviso", async () => {
    const r = await clicar();

    expect(r.status).toBe(201);
    expect(executadas).toEqual(["send_whatsapp_message", "send_email"]);
    const run = banco.inserts.find((i) => i.tabela === "automation_rule_runs")!.linha as {
      status: string;
      actions_result: Array<{ type: string; detail?: { dispatched_from_run_id?: string } }>;
    };
    expect(run.status).toBe("success");
    expect(run.actions_result.map((a) => [a.type, a.detail?.dispatched_from_run_id])).toEqual([
      ["send_whatsapp_message", RUN],
      ["send_email", RUN],
    ]);
    expect(statusDoAviso()).toBe("resolved");
    expect(vi.mocked(audit)).toHaveBeenCalledWith(expect.objectContaining({ action: "automation.held_actions_dispatched" }));
  });

  it("nada saiu (todas as paradas falharam): o run fica na Atividade, o aviso volta a ficar aberto e a resposta é erro", async () => {
    // Medido na prova de tela: o WhatsApp de `lead.won` falha com `internal_error`.
    // Responder 201 e deixar o aviso resolvido sumia com a única porta para
    // disparar de novo, sem nada ter chegado ao cliente.
    falham = ["send_whatsapp_message", "send_email"];

    const r = await clicar();
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("dispatch_failed");
    const run = banco.inserts.find((i) => i.tabela === "automation_rule_runs")!.linha as { status: string };
    expect(run.status).toBe("failed");
    expect(statusDoAviso()).toBe("open");
  });

  it("saiu uma parte: o aviso fica resolvido, porque reabrir convidaria a mandar de novo o que já saiu", async () => {
    falham = ["send_whatsapp_message"];

    const r = await clicar();
    expect(r.status).toBe(201);
    expect(executadas).toEqual(["send_whatsapp_message", "send_email"]);
    expect(statusDoAviso()).toBe("resolved");
  });

  it("adiada conta como saída: o aviso fica resolvido, senão o segundo clique mandaria em dobro", async () => {
    adiam = ["send_whatsapp_message"];
    falham = ["send_email"];

    const r = await clicar();
    expect(r.status).toBe(201);
    expect(statusDoAviso()).toBe("resolved");
  });

  it("o segundo clique não dispara de novo: o aviso já fechado é a trava", async () => {
    await clicar();
    executadas.length = 0;

    const r = await clicar();
    expect(r.status).toBe(409);
    expect(executadas).toEqual([]);
  });

  it("aviso descartado com 'Marcar resolvido' não dispara", async () => {
    banco.tabelas.agent_inbox_items![0]!.status = "resolved";

    const r = await clicar();
    expect(r.status).toBe(409);
    expect(executadas).toEqual([]);
  });

  it("fora da janela de envio nada sai e o aviso volta a ficar aberto", async () => {
    foraDaJanela = true;

    const r = await clicar();
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("dispatch_postponed");
    expect(executadas).toEqual([]);
    expect(statusDoAviso()).toBe("open");
  });

  it("regra que mudou depois (a posição aponta para outra ação) não dispara e reabre o aviso", async () => {
    mundo(["add_tag", "send_email", "send_whatsapp_message"]);

    const r = await clicar();
    expect(r.status).toBe(409);
    expect(executadas).toEqual([]);
    expect(statusDoAviso()).toBe("open");
  });

  it("quem não é gestor recebe a recusa do requireRole e nada sai", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }) as never,
    } as never);

    const r = await clicar();
    expect(r.status).toBe(403);
    expect(executadas).toEqual([]);
    expect(statusDoAviso()).toBe("open");
  });
});
