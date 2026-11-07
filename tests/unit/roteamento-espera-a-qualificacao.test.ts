/**
 * #3966 — A FILA ESPERA A IA QUALIFICAR (regra pura + a leitura que a alimenta).
 *
 * O defeito, medido no código: com rodízio/carga, `trg_conversation_routing_requested`
 * emite o pedido NO NASCIMENTO e `decideRouting` não perguntava se havia agente de
 * IA atendendo nem se a qualificação terminou. A entrega grava
 * `assignee_kind='user'` e o gate cala o agente (`conversa_de_humano`) — a fila
 * desligava a IA que deveria qualificar.
 *
 * Este arquivo prova as três coisas que a decisão precisa saber, sem banco:
 *
 *   1. com a IA qualificando, NADA é distribuído — nem pelo modo, nem pelo
 *      destino padrão do número (que também grava dono e calaria o agente);
 *   2. sem IA ligada, a conversa continua sendo distribuída no nascimento —
 *      o caso que impede a mudança de virar atraso geral;
 *   3. a leitura que responde "há IA atendendo?" usa a régua do MOTOR
 *      (`resolverAgenteDaConversa`) e falha ABERTA quando não consegue ler.
 */
import { describe, expect, it } from "vitest";

import { decideRouting, type RoutingCandidate } from "@/lib/routing/decide";
import {
  lerQualificacaoDaIA,
  qualificacaoEmCurso,
  silenciadoAgora,
  type ConversaParaQualificar,
} from "@/lib/routing/qualificacao-da-ia";
import { routingConfigSchema } from "@/lib/schemas/routing";

const NOW = new Date("2026-11-07T12:00:00Z");
const config = routingConfigSchema.parse({ mode: "round_robin", max_retries: 5, backoff_seconds: 60 });
const ANA: RoutingCandidate = { userId: "ana", currentLoad: 0, lastAssignedAt: null };

const conversa = (over: Partial<ConversaParaQualificar> = {}): ConversaParaQualificar => ({
  channel_session_id: "sessao-1",
  active_ai_agent_id: null,
  bot_silenced_until: null,
  last_handoff_at: null,
  assigned_to_user_id: null,
  ...over,
});

describe("decideRouting — a IA qualificando vence a fila (#3966)", () => {
  it("rodízio com elegível NÃO distribui enquanto a IA qualifica", () => {
    const action = decideRouting({
      mode: "round_robin",
      alreadyAssigned: false,
      eligibles: [ANA],
      config,
      attempts: 0,
      now: NOW,
      iaQualificando: true,
    });
    expect(action).toEqual({ kind: "skip", reason: "ia_qualificando" });
  });

  it("o destino padrão do NÚMERO também espera: entregar calaria a IA", () => {
    const action = decideRouting({
      mode: "manual",
      alreadyAssigned: false,
      eligibles: [],
      config,
      attempts: 0,
      now: NOW,
      defaultAssigneeUserId: "bruno",
      iaQualificando: true,
    });
    expect(action).toEqual({ kind: "skip", reason: "ia_qualificando" });
  });

  it("o caso que não pede humano continua vencendo — é dele a palavra final", () => {
    const action = decideRouting({
      mode: "round_robin",
      alreadyAssigned: false,
      eligibles: [ANA],
      config,
      attempts: 0,
      now: NOW,
      motivoDoCaso: "caso_aguardando_cliente",
      iaQualificando: true,
    });
    expect(action).toEqual({ kind: "skip", reason: "caso_aguardando_cliente" });
  });

  it("⭐ sem IA ligada, distribui no NASCIMENTO como sempre (compatibilidade)", () => {
    const action = decideRouting({
      mode: "round_robin",
      alreadyAssigned: false,
      eligibles: [ANA],
      config,
      attempts: 0,
      now: NOW,
      iaQualificando: false,
    });
    expect(action).toEqual({ kind: "assign", userId: "ana" });
  });

  it("a ausência do campo é o comportamento antigo (nem todo chamador o passa)", () => {
    const action = decideRouting({
      mode: "round_robin",
      alreadyAssigned: false,
      eligibles: [ANA],
      config,
      attempts: 0,
      now: NOW,
    });
    expect(action.kind).toBe("assign");
  });
});

describe("qualificacaoEmCurso — as quatro condições", () => {
  const base = { iaAtendeOCanal: true, passouParaHumano: false, agenteCalado: false, comHumano: false };

  it("agente no ar, sem handoff, sem silêncio ⇒ qualificando", () => {
    expect(qualificacaoEmCurso(base)).toBe(true);
  });

  it("sem agente atendendo o número ⇒ distribui (quem nunca teve IA não espera)", () => {
    expect(qualificacaoEmCurso({ ...base, iaAtendeOCanal: false })).toBe(false);
  });

  it("handoff gravado ⇒ a qualificação terminou e a conversa entra na fila", () => {
    expect(qualificacaoEmCurso({ ...base, passouParaHumano: true })).toBe(false);
  });

  it("agente calado (pausa manual) não é qualificação em curso", () => {
    expect(qualificacaoEmCurso({ ...base, agenteCalado: true })).toBe(false);
  });

  it("conversa com humano não é assunto da IA", () => {
    expect(qualificacaoEmCurso({ ...base, comHumano: true })).toBe(false);
  });

  it("silenciadoAgora: passado não cala, futuro cala, lixo não cala", () => {
    expect(silenciadoAgora(null, NOW)).toBe(false);
    expect(silenciadoAgora("2026-11-07T11:59:59Z", NOW)).toBe(false);
    expect(silenciadoAgora("2026-11-07T12:00:01Z", NOW)).toBe(true);
    expect(silenciadoAgora("infinity", NOW)).toBe(false);
    expect(silenciadoAgora("não-é-data", NOW)).toBe(false);
  });
});

/** Fake mínimo do client: responde por tabela e registra as leituras. */
function fakeClient(
  tabelas: Record<string, Array<Record<string, unknown>> | Error>,
  lidas: string[] = [],
) {
  const from = (tabela: string) => {
    lidas.push(tabela);
    const resultado = tabelas[tabela] ?? [];
    const filtros: Array<[string, unknown]> = [];
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => {
        filtros.push([k, v]);
        return q;
      },
      is: (k: string, v: unknown) => {
        filtros.push([k, v]);
        return q;
      },
      then: (resolve: (r: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) => {
        if (resultado instanceof Error) {
          return Promise.resolve({ data: null, error: { message: resultado.message } }).then(resolve, reject);
        }
        const linhas = resultado.filter((linha) =>
          filtros.every(([k, v]) => (v === null ? linha[k] === null : linha[k] === v)),
        );
        return Promise.resolve({ data: linhas, error: null }).then(resolve, reject);
      },
    };
    return q;
  };
  return { from } as never;
}

const AGENTE = {
  id: "agente-1",
  organization_id: "org-1",
  kind: "rag_bot",
  is_active: true,
  paused_at: null,
  published_version_id: "versao-1",
  archived_at: null,
  priority: 0,
  created_at: "2026-01-01T00:00:00Z",
};
const VERSAO = { id: "versao-1", organization_id: "org-1", channel_session_id: "sessao-1" };

describe("lerQualificacaoDaIA — a leitura que alimenta a decisão", () => {
  it("agente publicado no número, conversa sem handoff ⇒ qualificando", async () => {
    const client = fakeClient({ ai_agents: [AGENTE], ai_agent_versions: [VERSAO] });
    await expect(lerQualificacaoDaIA(client, "org-1", conversa(), NOW)).resolves.toBe(true);
  });

  it("⭐ nenhum agente na organização ⇒ distribui no nascimento", async () => {
    const client = fakeClient({ ai_agents: [], ai_agent_versions: [] });
    await expect(lerQualificacaoDaIA(client, "org-1", conversa(), NOW)).resolves.toBe(false);
  });

  it("agente pausado não conta como IA atendendo", async () => {
    const client = fakeClient({
      ai_agents: [{ ...AGENTE, paused_at: "2026-11-01T00:00:00Z" }],
      ai_agent_versions: [VERSAO],
    });
    await expect(lerQualificacaoDaIA(client, "org-1", conversa(), NOW)).resolves.toBe(false);
  });

  it("a conversa que já passou para humano não espera de novo", async () => {
    const client = fakeClient({ ai_agents: [AGENTE], ai_agent_versions: [VERSAO] });
    const c = conversa({ last_handoff_at: "2026-11-07T11:00:00Z" });
    await expect(lerQualificacaoDaIA(client, "org-1", c, NOW)).resolves.toBe(false);
  });

  it("a conversa silenciada (pausa da IA) vai para a fila", async () => {
    const client = fakeClient({ ai_agents: [AGENTE], ai_agent_versions: [VERSAO] });
    const c = conversa({ bot_silenced_until: "2026-11-08T00:00:00Z" });
    await expect(lerQualificacaoDaIA(client, "org-1", c, NOW)).resolves.toBe(false);
  });

  it("falha de leitura distribui (falha ABERTA) em vez de parar a fila de todos", async () => {
    const client = fakeClient({ ai_agents: new Error("banco fora") });
    await expect(lerQualificacaoDaIA(client, "org-1", conversa(), NOW)).resolves.toBe(false);
  });

  it("a régua do motor é a única: dois agentes sem vínculo com o número ⇒ indefinido ⇒ distribui", async () => {
    const client = fakeClient({
      ai_agents: [AGENTE, { ...AGENTE, id: "agente-2", published_version_id: "versao-2" }],
      ai_agent_versions: [],
    });
    await expect(lerQualificacaoDaIA(client, "org-1", conversa(), NOW)).resolves.toBe(false);
  });
});
