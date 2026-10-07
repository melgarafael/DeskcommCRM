import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyReactivityEvent,
  type LiveEnrollmentRef,
  type ReactivityAdminClient,
} from "@/lib/followup/reactivity";
import { aplicarRespostaNaCampanha } from "@/lib/campanhas/resposta";
import type { EventRow } from "@/lib/event-log/dispatcher";

/**
 * OS 12 CAMINHOS CALAM PARA PESSOAL (spec 21, etapa 10 — critério 6).
 *
 * Cada caminho que reage a mensagem nova ignora pessoal (`skipped`, sem
 * efeito). Caminhos 11 (MCP) e 12 (ligação) são da fatia 3; o caminho 2
 * (realtime do inbox) é consequência da etapa 7 — a invalidação chega e a
 * lista filtrada não mostra nada.
 *
 * ─── SABOTAGEM (prova no CI) ───────────────────────────────────────────────
 * - Ligar qualquer efeito de volta: o caso daquele caminho cai (a spec pede
 *   literalmente isso — um caso por caminho).
 * Linha para reverter: o arquivo citado em cada `describe`.
 */

const RAIZ = process.cwd();
const fonte = (...partes: string[]) => fs.readFileSync(path.join(RAIZ, ...partes), "utf8");
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";

function evento(over: Partial<EventRow> = {}): EventRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    organization_id: ORG,
    event_type: "message.received",
    entity_kind: "message",
    entity_id: null,
    payload: { contact_id: CONTATO, direction: "inbound" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...over,
  };
}

describe("caminho 1 — alerta no navegador não entrega aviso", () => {
  it("o hook pula o entregarAviso quando o contato é pessoal", () => {
    const src = semComentarios(fonte("hooks", "notifications", "useInboundMessageAlerts.ts"));
    expect(src).toMatch(/pessoal/);
    expect(src).toMatch(/if \(bits\.pessoal\) return;/);
  });
});

describe("caminho 2 — realtime do inbox é consequência da lista (etapa 7)", () => {
  it("a lista filtrada não mostra nada quando a invalidação chega", () => {
    const src = semComentarios(fonte("app", "api", "v1", "conversations", "_handler.ts"));
    expect(src).toMatch(/\.not\("contact_id",\s*"in"/);
  });
});

describe("caminho 3 — push no celular pula pessoal", () => {
  it("handleInbound devolve skipped/contato_pessoal", () => {
    const src = semComentarios(fonte("lib", "notifications", "push.handler.ts"));
    expect(src).toMatch(/is_personal/);
    expect(src).toMatch(/detail:\s*"contato_pessoal"/);
  });
});

describe("caminho 4 — follow-up quente cancela tudo e texto não alimenta", () => {
  function banco(pessoal: boolean) {
    const eventos: string[] = [];
    const patches: string[] = [];
    const inscricao: LiveEnrollmentRef = {
      id: "enr-1",
      status: "active",
      current_node_id: "w1",
      steps_taken: 1,
      pointer_id: "ptr-1",
      handoff_policy: "pause",
      trigger_config: null,
    };
    const db: ReactivityAdminClient = {
      async loadConversationContactId() {
        return CONTATO;
      },
      async loadContactBlocked() {
        return false;
      },
      async loadContactPersonal() {
        return pessoal;
      },
      async loadLiveEnrollmentsForContact() {
        return [inscricao];
      },
      async insertEnrollmentEvent(e) {
        eventos.push(e.event_type);
        return { inserted: true };
      },
      async updateEnrollment(id) {
        patches.push(id);
      },
      async agoraNoBanco() {
        return new Date().toISOString();
      },
    };
    return { db, eventos, patches };
  }

  it("pessoal cancela tudo com motivo próprio (nunca stop_keyword)", async () => {
    const { db, eventos, patches } = banco(true);
    const s = await applyReactivityEvent(db, () => new Date(), evento());
    expect(s.matched).toBe(true);
    expect(s.reacted).toBe(1);
    expect(eventos).toEqual(["reactivity_personal"]);
    expect(patches).toEqual(["enr-1"]);
  });

  it("normal segue reagindo como antes", async () => {
    const { db, eventos } = banco(false);
    const s = await applyReactivityEvent(db, () => new Date(), evento());
    expect(s.matched).toBe(true);
    expect(eventos).not.toContain("reactivity_personal");
  });

  it("aplicarTextoNosFollowups retorna cedo para pessoal", () => {
    const src = semComentarios(fonte("lib", "followup", "aplicar-inbound.ts"));
    expect(src).toMatch(/is_personal/);
  });
});

describe("caminho 5 — follow-up morno pula o enrollment de pessoal", () => {
  it("aplicarRespostasQueChegaram continua antes de aplicarRespostaInbound", () => {
    const src = semComentarios(fonte("lib", "relogio", "executar.ts"));
    expect(src).toMatch(/is_personal/);
    expect(src).toMatch(/continue;/);
  });
});

describe("caminho 6 — campanha não carimba resposta de pessoal", () => {
  interface EloLeitura {
    eq(coluna: string, valor: unknown): EloLeitura;
    maybeSingle(): Promise<{ data: unknown; error: null }>;
  }
  function banco(pessoal: boolean) {
    const q: EloLeitura = {
      eq: () => q,
      async maybeSingle() {
        return { data: { is_personal: pessoal }, error: null };
      },
    };
    return { from: () => ({ select: () => q }) } as never;
  }

  it("pessoal devolve {atribuiu:false, optOut:0} sem tocar em recipients", async () => {
    const r = await aplicarRespostaNaCampanha(banco(true), {
      organizationId: ORG,
      contactId: CONTATO,
      recebidoEm: new Date(),
    });
    expect(r).toEqual({ atribuiu: false, optOut: 0 });
  });

  it("fecharPorOptOut continua lendo is_blocked (pessoal não é STOP)", () => {
    const src = semComentarios(fonte("lib", "campanhas", "resposta.ts"));
    expect(src).toMatch(/is_blocked/);
  });
});

describe("caminho 7 — Jev não é perguntado para pessoal (belt)", () => {
  it("observarPedidos retorna nada antes de perguntar", () => {
    const src = semComentarios(fonte("lib", "ai", "decisao", "pedidos.ts"));
    expect(src).toMatch(/is_personal/);
  });
});

describe("caminho 8 — webhook/automação não casa evento de pessoal", () => {
  it("runAutomationForEvent pula com skipped/contato_pessoal", () => {
    const src = semComentarios(fonte("lib", "automation", "engine.ts"));
    expect(src).toMatch(/detail:\s*"contato_pessoal"/);
  });
});

describe("caminho 9 — distribuição não distribui pessoal", () => {
  it("processEvent marca skipped_contato_pessoal após ler a conversa", () => {
    const src = semComentarios(fonte("lib", "routing", "worker.ts"));
    expect(src).toMatch(/skipped_contato_pessoal/);
  });
});

describe("caminho 10 — métricas não somam pessoal", () => {
  it("uso da plataforma exclui mensagens de pessoal", () => {
    const src = semComentarios(
      fonte("app", "api", "v1", "admin", "usage", "route.ts"),
    );
    expect(src).toMatch(/is_personal/);
    expect(src).toMatch(/\.not\("contact_id",\s*"in"/);
  });

  it("opt-out da campanha conta opted_out_at (que pessoal nunca carimba)", () => {
    const src = semComentarios(
      fonte("app", "api", "v1", "campaigns", "[id]", "metrics", "route.ts"),
    );
    expect(src).toMatch(/opted_out_at !== null/);
    expect(src).not.toMatch(/personal/);
  });
});
