/**
 * #3852 — o follow-up escolhe o agente do NÚMERO DA CONVERSA.
 *
 * ─── O defeito medido ───────────────────────────────────────────────────────
 *
 * Com dois números, cada um com o seu agente publicado, o gate só olhava o
 * ponteiro: qualquer agente que armasse o fluxo concorria, e o vencedor era o
 * menor uuid. O fluxo do agente A pegava lead que conversou no número B e
 * escrevia com a persona errada.
 *
 * ─── O que este arquivo prende ──────────────────────────────────────────────
 *
 * 1. `decidirAgenteDoEnrollmentAutomatico` aceita o canal como parâmetro
 *    OPCIONAL. Com canal, só concorrem agentes publicados nele; sem canal, a
 *    escolha é a de hoje (menor uuid) — compatibilidade dos chamadores que não
 *    têm conversa (prévia de fluxos).
 * 2. `runSilenceSweep` decide POR CONTATO: o silêncio de um lead no número B
 *    nunca é inscrito com o agente do número A. Sem agente daquele número e
 *    fluxo que pede IA, o contato é pulado (contador próprio), não inscrito.
 * 3. Os QUATRO produtores que passam pelo gate — etapa, lead, caso e retorno —
 *    entregam o canal da conversa. Cada um tem a sua asserção; um deles fora
 *    do conserto é o defeito de novo, num caminho diferente.
 *
 * ─── SABOTAGEM (previsto antes de rodar) ────────────────────────────────────
 *
 * - Tirar o `.filter(channelSessionIds...)` de `agentsEnablingPointer` → o
 *   teste do gate e os quatro gatilhos ficam VERMELHOS (volta o menor uuid).
 * - Não passar `canal` em um dos quatro gatilhos → só a asserção daquele
 *   gatilho fica VERMELHA.
 * - Remover `loadCanalDosContatos` do sweep (ou ignorar o mapa no laço) → o
 *   caso "silêncio do A não escreve no lead do B" fica VERMELHO.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";
import {
  decidirAgenteDoEnrollmentAutomatico,
  resolveAgentForAutomaticTrigger,
  type EnabledFollowupAgent,
  type FollowupGateDb,
} from "@/lib/followup/agent-followup-gate";
import { EVENTO_CASO_ABERTO, aplicaGatilhoDeCaso, type GatilhoCasoDb } from "@/lib/followup/gatilho-caso";
import { EVENTO_DE_ETAPA, aplicaGatilhoDeEtapa, type GatilhoEtapaDb } from "@/lib/followup/gatilho-etapa";
import { EVENTO_DE_LEAD_CRIADO, aplicaGatilhoDeLead, type GatilhoLeadDb } from "@/lib/followup/gatilho-lead";
import { EVENTO_DE_RETORNO, aplicaGatilhoDeRetorno, type GatilhoRetornoDb } from "@/lib/followup/gatilho-retorno";
import { runSilenceSweep, type SilenceSweepDb } from "@/lib/followup/silence-sweep";

const ORG = "11111111-1111-1111-1111-111111111111";
const POINTER_A = "22222222-2222-2222-2222-222222222222";
const POINTER_B = "33333333-3333-3333-3333-333333333333";
const VERSION = "99999999-9999-9999-9999-999999999999";

// A é o MENOR uuid de propósito: é quem o comportamento antigo escolhia para
// todo mundo. Se o canal for ignorado, os testes pegam A onde devia ser B.
const AGENTE_A = "a0000000-0000-4000-8000-000000000001";
const AGENTE_B = "f0000000-0000-4000-8000-000000000002";
const CANAL_A = "canal-whatsapp-a";
const CANAL_B = "canal-whatsapp-b";

const CONTATO_A = "c0000000-0000-4000-8000-000000000001";
const CONTATO_B = "c0000000-0000-4000-8000-000000000002";
const CONVERSA_B = "d0000000-0000-4000-8000-000000000002";
const MENSAGEM_B = "e0000000-0000-4000-8000-000000000002";
const CASO_B = "f1000000-0000-4000-8000-000000000002";
const NEGOCIO_B = "f2000000-0000-4000-8000-000000000002";
const ETAPA = "f3000000-0000-4000-8000-000000000003";
const ENROLLMENT = "a1000000-0000-4000-8000-000000000001";

const CLOCK = () => new Date("2026-09-22T15:00:00.000Z");

function fakeGate(agentes: EnabledFollowupAgent[]): FollowupGateDb {
  return {
    async loadEnabledPublishedFollowupAgents() {
      return agentes;
    },
  };
}

/** Os dois agentes do cenário: A (menor uuid) no canal A, B no canal B. */
const DOIS_AGENTES: EnabledFollowupAgent[] = [
  { agentId: AGENTE_A, pointerIds: [POINTER_A, POINTER_B], channelSessionIds: [CANAL_A] },
  { agentId: AGENTE_B, pointerIds: [POINTER_A, POINTER_B], channelSessionIds: [CANAL_B] },
];

const SO_O_AGENTE_A: EnabledFollowupAgent[] = [
  { agentId: AGENTE_A, pointerIds: [POINTER_A, POINTER_B], channelSessionIds: [CANAL_A] },
];

describe("#3852 · o gate escolhe pelo canal da conversa", () => {
  it("com canal, o agente é o publicado NAQUELE número", async () => {
    const db = fakeGate(DOIS_AGENTES);
    await expect(resolveAgentForAutomaticTrigger(db, ORG, POINTER_B, CANAL_A)).resolves.toBe(AGENTE_A);
    await expect(resolveAgentForAutomaticTrigger(db, ORG, POINTER_B, CANAL_B)).resolves.toBe(AGENTE_B);
  });

  it("SEM canal, o comportamento é o de hoje: menor uuid", async () => {
    const db = fakeGate(DOIS_AGENTES);
    await expect(resolveAgentForAutomaticTrigger(db, ORG, POINTER_B)).resolves.toBe(AGENTE_A);
    await expect(resolveAgentForAutomaticTrigger(db, ORG, POINTER_B, null)).resolves.toBe(AGENTE_A);
  });

  it("canal sem agente que arma o pointer → gate-out (não escolhe o de outro número)", async () => {
    const db = fakeGate(SO_O_AGENTE_A);
    await expect(
      decidirAgenteDoEnrollmentAutomatico(db, ORG, POINTER_B, true, CANAL_B),
    ).resolves.toEqual({ agentId: null, barrado: true });
    // Texto fixo no mesmo canal sem agente continua podendo seguir, com agent_id nulo.
    await expect(
      decidirAgenteDoEnrollmentAutomatico(db, ORG, POINTER_B, false, CANAL_B),
    ).resolves.toEqual({ agentId: null, barrado: false });
  });

  it("o adapter de produção lê o número da versão publicada", () => {
    const fonte = fs.readFileSync(
      path.join(process.cwd(), "lib", "followup", "agent-followup-gate.ts"),
      "utf8",
    );
    expect(fonte, "a query do gate deixou de trazer o canal da versão").toMatch(
      /\.select\("agent_id, followup, channel_session_id"\)/,
    );
    expect(fonte).toMatch(/channelSessionIds:\s*\[\.\.\.v\.channelSessionIds\]/);
  });
});

// ─── Silêncio: dois números, dois agentes, dois leads ───────────────────────

function sweepDb(opts: {
  canais: Map<string, string | null>;
  registros: Array<{ pointer_id: string; contact_id: string; agent_id: string | null }>;
  contatos?: string[];
}): SilenceSweepDb {
  return {
    async loadActiveSilencePointers() {
      return [POINTER_A, POINTER_B].map((id) => ({
        id,
        organization_id: ORG,
        active_version_id: VERSION,
        threshold_minutes: 60,
        segments: [],
      }));
    },
    async loadSilentContactIds() {
      return opts.contatos ?? [CONTATO_A, CONTATO_B];
    },
    async loadContatosComRetornoVivo() {
      return new Set<string>();
    },
    async loadEncerramentosDoFluxo() {
      return new Map();
    },
    async loadContatosComPessoaNoComando() {
      return new Set<string>();
    },
    async loadContactIdsEmCooldown() {
      return new Set<string>();
    },
    async loadContatosComInscricaoViva() {
      return new Set<string>();
    },
    async loadCanalDosContatos(_org, contactIds) {
      const mapa = new Map<string, string | null>();
      for (const id of contactIds) mapa.set(id, opts.canais.get(id) ?? null);
      return mapa;
    },
    async loadTriggerNode() {
      return { id: "t1", pedeAgente: true };
    },
    async insertEnrollment(input) {
      opts.registros.push({
        pointer_id: input.pointer_id,
        contact_id: input.contact_id,
        agent_id: input.agent_id,
      });
      return { inserted: true };
    },
  };
}

describe("#3852 · silêncio não escreve no lead de outro número", () => {
  it("o fluxo do agente A inscreve o lead do número A e NÃO o do número B", async () => {
    const registros: Array<{ pointer_id: string; contact_id: string; agent_id: string | null }> = [];
    const summary = await runSilenceSweep({
      // Ponto A armado só pelo agente A; ponto B só pelo agente B.
      db: sweepDb({
        canais: new Map([
          [CONTATO_A, CANAL_A],
          [CONTATO_B, CANAL_B],
        ]),
        registros,
      }),
      gateDb: fakeGate([
        { agentId: AGENTE_A, pointerIds: [POINTER_A], channelSessionIds: [CANAL_A] },
        { agentId: AGENTE_B, pointerIds: [POINTER_B], channelSessionIds: [CANAL_B] },
      ]),
      clock: CLOCK,
    });

    // Um enrollment por fluxo, cada um no SEU número e com o SEU agente.
    expect(registros).toHaveLength(2);
    expect(registros).toContainEqual({ pointer_id: POINTER_A, contact_id: CONTATO_A, agent_id: AGENTE_A });
    expect(registros).toContainEqual({ pointer_id: POINTER_B, contact_id: CONTATO_B, agent_id: AGENTE_B });
    // O que NÃO pode existir: o fluxo do A no lead do B (e vice-versa).
    expect(registros).not.toContainEqual(
      expect.objectContaining({ pointer_id: POINTER_A, contact_id: CONTATO_B }),
    );
    expect(registros).not.toContainEqual(
      expect.objectContaining({ pointer_id: POINTER_B, contact_id: CONTATO_A }),
    );
    // A varredura conta o contato pulado por falta de agente no canal.
    expect(summary.skipped_sem_agente_no_canal).toBe(2);
    expect(summary.enrolled).toBe(2);
  });

  it("fluxo do A com o lead do B: pula em vez de pinar o agente errado", async () => {
    const registros: Array<{ pointer_id: string; contact_id: string; agent_id: string | null }> = [];
    const summary = await runSilenceSweep({
      db: sweepDb({
        canais: new Map([[CONTATO_B, CANAL_B]]),
        registros,
        contatos: [CONTATO_B],
      }),
      // O agente A arma os DOIS pointers, mas só atende o canal A. O lead B está
      // no canal B: nenhum pointer pode inscrevê-lo com a persona do A.
      gateDb: fakeGate(SO_O_AGENTE_A),
      clock: CLOCK,
    });

    expect(registros).toHaveLength(0);
    expect(summary.skipped_sem_agente_no_canal).toBe(2);
  });
});

// ─── Os quatro produtores que passam pelo gate ─────────────────────────────

interface RegistroDeEnrollment {
  agent_id: string | null;
  contact_id: string;
  conversation_id?: string;
}

function eventoDeEtapa(): EventRow {
  return {
    id: "e0000000-0000-4000-8000-000000000101",
    organization_id: ORG,
    event_type: EVENTO_DE_ETAPA,
    entity_kind: "crm_lead",
    entity_id: NEGOCIO_B,
    payload: { to_stage_id: ETAPA, service_origin: {} },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

function dbDeEtapa(canal: string | null, registros: RegistroDeEnrollment[]): GatilhoEtapaDb {
  return {
    async carregaPointersDeEtapa() {
      return [{ id: POINTER_A, organization_id: ORG, active_version_id: VERSION, stage_id: ETAPA }];
    },
    async carregaContatoDoNegocio() {
      return CONTATO_B;
    },
    async carregaCanalDoContato() {
      return canal;
    },
    async carregaNoDeGatilho() {
      return { id: "t1", pedeAgente: true };
    },
    async insereEnrollment(input) {
      registros.push({ agent_id: input.agent_id, contact_id: input.contact_id });
      return { inserted: true, id: ENROLLMENT };
    },
    async insereEventoDoEnrollment() {},
  };
}

function eventoDeLead(): EventRow {
  return {
    id: "e0000000-0000-4000-8000-000000000102",
    organization_id: ORG,
    event_type: EVENTO_DE_LEAD_CRIADO,
    entity_kind: "crm_lead",
    entity_id: NEGOCIO_B,
    payload: {},
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

function dbDeLead(canal: string | null, registros: RegistroDeEnrollment[]): GatilhoLeadDb {
  return {
    async carregaPointersDeLead() {
      return [{ id: POINTER_A, organization_id: ORG, active_version_id: VERSION }];
    },
    async carregaContatoDoNegocio() {
      return CONTATO_B;
    },
    async carregaCanalDoContato() {
      return canal;
    },
    async carregaNoDeGatilho() {
      return { id: "t1", pedeAgente: true };
    },
    async insereEnrollment(input) {
      registros.push({ agent_id: input.agent_id, contact_id: input.contact_id });
      return { inserted: true, id: ENROLLMENT };
    },
    async insereEventoDoEnrollment() {},
  };
}

function eventoDeCaso(): EventRow {
  return {
    id: "e0000000-0000-4000-8000-000000000103",
    organization_id: ORG,
    event_type: EVENTO_CASO_ABERTO,
    entity_kind: "agent_case",
    entity_id: CASO_B,
    payload: {
      case_id: CASO_B,
      conversation_id: CONVERSA_B,
      contact_id: CONTATO_B,
      source: "agent",
      status: "awaiting_human",
    },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: CLOCK().toISOString(),
  };
}

function dbDeCaso(canal: string | null, registros: RegistroDeEnrollment[]): GatilhoCasoDb {
  return {
    async carregaPointersDeCaso() {
      return [{ id: POINTER_A, organization_id: ORG, active_version_id: VERSION }];
    },
    async carregaContatoDaConversa() {
      return CONTATO_B;
    },
    async carregaCanalDaConversa() {
      return canal;
    },
    async carregaNoDeGatilho() {
      return { id: "t1", pedeAgente: true };
    },
    async insereEnrollment(input) {
      registros.push({
        agent_id: input.agent_id,
        contact_id: input.contact_id,
        conversation_id: input.conversation_id,
      });
      return { inserted: true, id: ENROLLMENT };
    },
    async insereEventoDoEnrollment() {},
    async carregaVivosDoCaso() {
      return [];
    },
    async cancelaEnrollment() {
      return true;
    },
  };
}

function eventoDeRetorno(): EventRow {
  return {
    id: "e0000000-0000-4000-8000-000000000104",
    organization_id: ORG,
    event_type: EVENTO_DE_RETORNO,
    entity_kind: "message",
    entity_id: MENSAGEM_B,
    payload: { contact_id: CONTATO_B, conversation_id: CONVERSA_B, message_id: MENSAGEM_B },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

function dbDeRetorno(canal: string | null, registros: RegistroDeEnrollment[]): GatilhoRetornoDb {
  return {
    async carregaPointersDeRetorno() {
      return [
        { id: POINTER_A, organization_id: ORG, active_version_id: VERSION, threshold_minutes: 60, segments: [] },
      ];
    },
    async carregaInboundAnterior() {
      return new Date(CLOCK().getTime() - 2 * 60 * 60_000);
    },
    async carregaEstadoDaConversa() {
      return {
        is_group: false,
        is_blocked: false,
        force_human: false,
        assignee_kind: "ai",
        bot_silenced_until: null,
        tags: [],
        canal,
      };
    },
    async carregaEnrollmentVivo() {
      return null;
    },
    async carregaNoDeGatilho() {
      return { id: "t1", pedeAgente: true };
    },
    async insereEnrollment(input) {
      registros.push({
        agent_id: input.agent_id,
        contact_id: input.contact_id,
        conversation_id: input.conversation_id,
      });
      return { inserted: true, id: ENROLLMENT };
    },
    async insereEventoDoEnrollment() {},
  };
}

describe("#3852 · os QUATRO gatilhos honram o canal", () => {
  it("stage_change (gatilho-etapa.ts): conversa no B pina o agente do B", async () => {
    const registros: RegistroDeEnrollment[] = [];
    await aplicaGatilhoDeEtapa(
      { db: dbDeEtapa(CANAL_B, registros), gateDb: fakeGate(DOIS_AGENTES), clock: CLOCK },
      eventoDeEtapa(),
    );
    expect(registros).toHaveLength(1);
    expect(registros[0]?.agent_id, "ignorou o canal e pinou o agente de menor uuid").toBe(AGENTE_B);
  });

  it("stage_change: sem agente no número da conversa, NÃO inscreve com o de outro", async () => {
    const registros: RegistroDeEnrollment[] = [];
    await aplicaGatilhoDeEtapa(
      { db: dbDeEtapa(CANAL_B, registros), gateDb: fakeGate(SO_O_AGENTE_A), clock: CLOCK },
      eventoDeEtapa(),
    );
    expect(registros).toHaveLength(0);
  });

  it("lead_created (gatilho-lead.ts): conversa no B pina o agente do B", async () => {
    const registros: RegistroDeEnrollment[] = [];
    await aplicaGatilhoDeLead(
      { db: dbDeLead(CANAL_B, registros), gateDb: fakeGate(DOIS_AGENTES), clock: CLOCK },
      eventoDeLead(),
    );
    expect(registros).toHaveLength(1);
    expect(registros[0]?.agent_id, "ignorou o canal e pinou o agente de menor uuid").toBe(AGENTE_B);
  });

  it("lead_created: sem agente no número da conversa, NÃO inscreve com o de outro", async () => {
    const registros: RegistroDeEnrollment[] = [];
    await aplicaGatilhoDeLead(
      { db: dbDeLead(CANAL_B, registros), gateDb: fakeGate(SO_O_AGENTE_A), clock: CLOCK },
      eventoDeLead(),
    );
    expect(registros).toHaveLength(0);
  });

  it("case_opened (gatilho-caso.ts): case aberto no B pina o agente do B", async () => {
    const registros: RegistroDeEnrollment[] = [];
    await aplicaGatilhoDeCaso(
      { db: dbDeCaso(CANAL_B, registros), gateDb: fakeGate(DOIS_AGENTES), clock: CLOCK },
      eventoDeCaso(),
    );
    expect(registros).toHaveLength(1);
    expect(registros[0]?.agent_id, "ignorou o canal e pinou o agente de menor uuid").toBe(AGENTE_B);
  });

  it("case_opened: sem agente no número da conversa, NÃO inscreve com o de outro", async () => {
    const registros: RegistroDeEnrollment[] = [];
    await aplicaGatilhoDeCaso(
      { db: dbDeCaso(CANAL_B, registros), gateDb: fakeGate(SO_O_AGENTE_A), clock: CLOCK },
      eventoDeCaso(),
    );
    expect(registros).toHaveLength(0);
  });

  it("inbound_after_silence (gatilho-retorno.ts): retorno no B pina o agente do B", async () => {
    const registros: RegistroDeEnrollment[] = [];
    await aplicaGatilhoDeRetorno(
      { db: dbDeRetorno(CANAL_B, registros), gateDb: fakeGate(DOIS_AGENTES), clock: CLOCK },
      eventoDeRetorno(),
    );
    expect(registros).toHaveLength(1);
    expect(registros[0]?.agent_id, "ignorou o canal e pinou o agente de menor uuid").toBe(AGENTE_B);
  });

  it("inbound_after_silence: sem agente no número da conversa, NÃO inscreve com o de outro", async () => {
    const registros: RegistroDeEnrollment[] = [];
    await aplicaGatilhoDeRetorno(
      { db: dbDeRetorno(CANAL_B, registros), gateDb: fakeGate(SO_O_AGENTE_A), clock: CLOCK },
      eventoDeRetorno(),
    );
    expect(registros).toHaveLength(0);
  });
});
