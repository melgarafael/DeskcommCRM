import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { loadAuthUser } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

import { POST } from "./route";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";

/**
 * OS EFEITOS DO MARCAR, UM POR UM (spec 21, etapa 4, critério 8).
 *
 * Ordem fixa na rota: contato → follow-ups → retornos avulsos → campanha →
 * prospecção → conversas → auditoria + timeline. Cada caso abaixo mede UM
 * efeito com os outros zerados — ligar qualquer efeito de volta (a sabotagem
 * que a spec pede) derruba o caso daquele efeito.
 *
 * ─── SABOTAGEM (prova no CI; linha para reverter: `route.ts`) ──────────────
 * - Cancelar só o fluxo e deixar o retorno: "retorno avulso" cai (o retorno
 *   dispararia depois — critério 8).
 * - Usar `opted_out` no recipient: "saída própria" cai (a taxa de opt-out
 *   mexeria com quem nunca pediu — D7).
 * - Apagar a linha do recipient em vez de marcar a saída: a métrica perde o
 *   denominador (aqui: a linha some do mapa e "saída própria" cai).
 * - Fechar antes de soltar: `fn_conversation_assign` com nulo volta para
 *   `open` e "solta antes de fechar" cai.
 * - Reativar follow-up ao desmarcar: coberto pelo teste de volta (etapa 5).
 */

interface Linha {
  id: string;
  organization_id: string;
  contact_id?: string;
  status: string;
  [k: string]: unknown;
}

const tabelas: Record<string, Linha[]> = {};
let eventosDeEnrollment: Array<Record<string, unknown>> = [];
let atividades: Array<Record<string, unknown>> = [];
const chamadasRpc: Array<{ funcao: string; args: Record<string, unknown> }> = [];
/** O que a RPC de remoção de trechos do RAG devolve no fake (#2394). */
let trechosDeRagRemovidos = 0;

const contexto = () => ({ params: Promise.resolve({ id: CONTATO }) });
const req = () => new NextRequest(`http://localhost/api/v1/contacts/${CONTATO}/personal`, { method: "POST" });

function casa(linha: Linha, filtros: Record<string, unknown>, ins: Record<string, unknown[]>): boolean {
  for (const [k, v] of Object.entries(filtros)) {
    if ((linha[k] as unknown) !== v) return false;
  }
  for (const [k, vs] of Object.entries(ins)) {
    if (!vs.includes(linha[k] as string)) return false;
  }
  return true;
}

function fakeQuery(tabela: string) {
  const estado = {
    op: "select" as "select" | "update" | "insert",
    patch: {} as Record<string, unknown>,
    filtros: {} as Record<string, unknown>,
    ins: {} as Record<string, unknown[]>,
    nulo: [] as string[],
    inserido: null as Record<string, unknown> | null,
  };
  const linhas = () => tabelas[tabela] ?? [];
  const resultado = () => {
    if (estado.op === "insert") {
      if (tabela === "followup_enrollment_events") eventosDeEnrollment.push(estado.inserido!);
      if (tabela === "crm_lead_activities") atividades.push(estado.inserido!);
      return { data: null, error: null };
    }
    if (estado.op === "update") {
      const alvos = linhas().filter((l) => {
        if (!casa(l, estado.filtros, estado.ins)) return false;
        for (const c of estado.nulo) if (l[c] !== null && l[c] !== undefined) return false;
        return true;
      });
      for (const a of alvos) Object.assign(a, estado.patch);
      return { data: alvos.map((a) => ({ id: a.id })), error: null };
    }
    // select
    if (tabela === "contacts") {
      const linha = linhas().find((l) => casa(l, estado.filtros, estado.ins));
      return { data: linha ? { ...linha } : null, error: null };
    }
    return { data: linhas().filter((l) => casa(l, estado.filtros, estado.ins)).map((l) => ({ ...l })), error: null };
  };
  const q = {
    select: () => q,
    update: (p: Record<string, unknown>) => {
      estado.op = "update";
      estado.patch = p;
      return q;
    },
    insert: (linha: Record<string, unknown>) => {
      estado.op = "insert";
      estado.inserido = linha;
      return q;
    },
    eq: (k: string, v: unknown) => {
      estado.filtros[k] = v;
      return q;
    },
    in: (k: string, v: unknown[]) => {
      estado.ins[k] = v;
      return q;
    },
    is: (k: string, v: null) => {
      if (v === null) estado.nulo.push(k);
      return q;
    },
    order: () => q,
    limit: () => q,
    maybeSingle: async () => resultado(),
    single: async () => resultado(),
    then: (res: (v: unknown) => unknown) => Promise.resolve(resultado()).then(res),
  };
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(tabelas)) delete tabelas[k];
  eventosDeEnrollment = [];
  atividades = [];
  chamadasRpc.length = 0;
  trechosDeRagRemovidos = 0;
  tabelas["contacts"] = [{ id: CONTATO, organization_id: ORG, status: "", display_name: "Mello", is_personal: false } as Linha];
  tabelas["crm_leads"] = [];
  tabelas["crm_pipelines"] = [];
  tabelas["followup_enrollments"] = [];
  tabelas["cron_jobs"] = [];
  tabelas["campaign_recipients"] = [];
  tabelas["prospecting_candidates"] = [];
  tabelas["conversations"] = [];
  vi.mocked(loadAuthUser).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ORG, idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  } as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => fakeQuery(tabela),
    rpc: async (funcao: string, args: Record<string, unknown>) => {
      chamadasRpc.push({ funcao, args });
      if (funcao === "fn_conversation_assign") return { data: [{ id: args["p_conversation_id"] }], error: null };
      if (funcao === "fn_contato_pessoal_remove_trechos_do_rag") return { data: trechosDeRagRemovidos, error: null };
      return { data: { id: args["p_conversation"] }, error: null };
    },
  } as unknown as ReturnType<typeof createAdminClient>);
  vi.mocked(audit).mockResolvedValue(undefined);
});

const acoesDeAuditoria = () => vi.mocked(audit).mock.calls.map((c) => c[0]?.action);

describe("marcar: cancela fluxo, dormente e coletando (parada total)", () => {
  it("vivo + dormente + coletando viram cancelled com motivo próprio", async () => {
    tabelas["followup_enrollments"] = ["active", "waiting_reply", "paused_handoff", "dormente", "coletando"].map(
      (status, i) => ({
        id: `e${i}`,
        organization_id: ORG,
        contact_id: CONTATO,
        status,
        current_node_id: `n${i}`,
      }) as Linha,
    );
    const resposta = await POST(req(), contexto());
    expect(resposta.status).toBe(200);
    for (const e of tabelas["followup_enrollments"]!) {
      expect(e["status"]).toBe("cancelled");
      expect(e["cancel_reason"]).toBe("pessoal");
    }
    expect(eventosDeEnrollment.filter((v) => v["event_type"] === "cancelled_personal")).toHaveLength(5);
    expect(acoesDeAuditoria().filter((a) => a === "followup_enrollment.cancelled")).toHaveLength(5);
  });

  it("pausado à mão segue o bloqueio: não é alcançado (fatia 2 veta no envio)", async () => {
    tabelas["followup_enrollments"] = [
      { id: "m1", organization_id: ORG, contact_id: CONTATO, status: "paused_manual", current_node_id: "n" } as Linha,
    ];
    await POST(req(), contexto());
    expect(tabelas["followup_enrollments"]![0]!["status"]).toBe("paused_manual");
  });

  it("encerrado não é reescrito", async () => {
    tabelas["followup_enrollments"] = [
      { id: "t1", organization_id: ORG, contact_id: CONTATO, status: "cancelled", current_node_id: "n" } as Linha,
    ];
    await POST(req(), contexto());
    expect(acoesDeAuditoria()).not.toContain("followup_enrollment.cancelled");
  });
});

describe("marcar: cancela o retorno avulso pendente", () => {
  it("promessa viva é desligada e auditada como followup.cancelled", async () => {
    tabelas["cron_jobs"] = [
      { id: "j1", organization_id: ORG, contact_id: CONTATO, status: "", kind: "at", job_kind: "followup_turn", enabled: true, cancelled_at: null } as Linha,
    ];
    await POST(req(), contexto());
    const job = tabelas["cron_jobs"]![0]!;
    expect(job["enabled"]).toBe(false);
    expect(job["cancelled_at"]).not.toBeNull();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "followup.cancelled", resourceType: "cron_job", resourceId: "j1" }),
    );
  });

  it("retorno já disparado não é tocado", async () => {
    tabelas["cron_jobs"] = [
      { id: "j2", organization_id: ORG, contact_id: CONTATO, status: "", kind: "at", job_kind: "followup_turn", enabled: false, cancelled_at: null } as Linha,
    ];
    await POST(req(), contexto());
    expect(acoesDeAuditoria()).not.toContain("followup.cancelled");
  });
});

describe("marcar: saída de campanha com status próprio (D7)", () => {
  it("recipient sai como `personal`, nunca `opted_out`", async () => {
    tabelas["campaign_recipients"] = [
      { id: "r1", organization_id: ORG, contact_id: CONTATO, status: "queued", opted_out_at: null } as Linha,
    ];
    await POST(req(), contexto());
    const r = tabelas["campaign_recipients"]![0]!;
    expect(r["status"]).toBe("personal");
    expect(r["eligibility_status"]).toBe("excluded");
    expect(r["exclusion_reason"]).toBe("contato_pessoal");
    expect(r["opted_out_at"]).toBeNull();
  });

  it("linha já saída não é reescrita", async () => {
    tabelas["campaign_recipients"] = [
      { id: "r2", organization_id: ORG, contact_id: CONTATO, status: "personal" } as Linha,
    ];
    const resposta = await POST(req(), contexto());
    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as { data: { effects: { campanha_saidas: number } } };
    expect(corpo.data.effects.campanha_saidas).toBe(0);
  });
});

describe("marcar: prospecção vira pulada com motivo próprio", () => {
  it("new e queued viram skipped/contato_pessoal; sent não é tocado", async () => {
    tabelas["prospecting_candidates"] = [
      { id: "p1", organization_id: ORG, contact_id: CONTATO, status: "new" } as Linha,
      { id: "p2", organization_id: ORG, contact_id: CONTATO, status: "queued" } as Linha,
      { id: "p3", organization_id: ORG, contact_id: CONTATO, status: "sent" } as Linha,
    ];
    await POST(req(), contexto());
    const porId = Object.fromEntries(tabelas["prospecting_candidates"]!.map((p) => [p.id, p]));
    expect(porId["p1"]!["status"]).toBe("skipped");
    expect(porId["p1"]!["error"]).toBe("contato_pessoal");
    expect(porId["p2"]!["status"]).toBe("skipped");
    expect(porId["p3"]!["status"]).toBe("sent");
  });
});

describe("marcar: fecha conversas e tira do atendente", () => {
  it("solta antes de fechar, audita os dois, conta uma", async () => {
    tabelas["conversations"] = [
      { id: "c1", organization_id: ORG, contact_id: CONTATO, status: "claimed", assigned_to_user_id: "alguem" } as Linha,
    ];
    const resposta = await POST(req(), contexto());
    expect(resposta.status).toBe(200);
    expect(chamadasRpc.map((c) => c.funcao)).toEqual([
      "fn_conversation_assign",
      "fn_service_status",
      "fn_contato_pessoal_remove_trechos_do_rag",
    ]);
    expect(chamadasRpc[0]!.args).toMatchObject({
      p_conversation_id: "c1",
      p_to_user_id: null,
      p_reason: "release",
      p_enforce_expected: false,
    });
    expect(chamadasRpc[1]!.args).toMatchObject({ p_conversation: "c1", p_status: "closed" });
    expect(acoesDeAuditoria()).toContain("conversation.released");
    expect(acoesDeAuditoria()).toContain("conversation.closed");
    const corpo = (await resposta.json()) as { data: { effects: { conversas_fechadas: number } } };
    expect(corpo.data.effects.conversas_fechadas).toBe(1);
  });

  it("conversa já fechada não é tocada", async () => {
    tabelas["conversations"] = [
      { id: "c2", organization_id: ORG, contact_id: CONTATO, status: "closed", assigned_to_user_id: null } as Linha,
    ];
    await POST(req(), contexto());
    expect(chamadasRpc.filter((c) => c.funcao !== "fn_contato_pessoal_remove_trechos_do_rag")).toHaveLength(0);
    expect(acoesDeAuditoria()).not.toContain("conversation.closed");
  });
});

describe("marcar: a prova fecha a conta", () => {
  it("auditoria carrega os contadores e a timeline usa o tipo novo", async () => {
    tabelas["followup_enrollments"] = [
      { id: "e1", organization_id: ORG, contact_id: CONTATO, status: "active", current_node_id: "n" } as Linha,
    ];
    tabelas["crm_leads"] = [
      { id: "lead1", organization_id: ORG, contact_id: CONTATO, pipeline_id: "f1", status: "open", last_activity_at: null, created_at: "2026-01-01T00:00:00Z" },
    ];
    await POST(req(), contexto());
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact.marked_personal",
        metadata: expect.objectContaining({ followups_cancelados: 1 }),
      }),
    );
    expect(atividades).toHaveLength(1);
    expect(atividades[0]).toMatchObject({ type: "contact_marked_personal", lead_id: "lead1" });
  });
});

describe("marcar: tira do RAG os trechos já ingeridos (#2394)", () => {
  it("chama a remoção com a organização e o contato, conta nos effects e na auditoria", async () => {
    trechosDeRagRemovidos = 3;
    const resposta = await POST(req(), contexto());
    expect(resposta.status).toBe(200);
    const chamada = chamadasRpc.find((c) => c.funcao === "fn_contato_pessoal_remove_trechos_do_rag");
    expect(chamada?.args).toEqual({ p_org: ORG, p_contact: CONTATO });
    const corpo = (await resposta.json()) as {
      data: { effects: { trechos_de_rag_removidos: number } };
    };
    expect(corpo.data.effects.trechos_de_rag_removidos).toBe(3);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact.marked_personal",
        metadata: expect.objectContaining({ trechos_de_rag_removidos: 3 }),
      }),
    );
  });

  it("sem trechos ingeridos, conta zero e a resposta continua 200", async () => {
    trechosDeRagRemovidos = 0;
    const resposta = await POST(req(), contexto());
    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as {
      data: { effects: { trechos_de_rag_removidos: number } };
    };
    expect(corpo.data.effects.trechos_de_rag_removidos).toBe(0);
  });
});
