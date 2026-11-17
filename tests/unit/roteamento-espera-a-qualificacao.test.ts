/**
 * #3966 — A FILA PODE ESPERAR A IA QUALIFICAR (regra pura + a leitura que a alimenta).
 *
 * O defeito, medido por @webtecnica no #4238: com rodízio/carga,
 * `trg_conversation_routing_requested` emite o pedido NO NASCIMENTO e
 * `decideRouting` não perguntava se havia agente de IA atendendo nem se a
 * qualificação terminou. A entrega grava `assignee_kind='user'` e o gate cala o
 * agente (`conversa_de_humano`) — a fila desligava a IA que deveria qualificar.
 *
 * A espera é OPÇÃO DO NÚMERO, desligada de fábrica, com prazo máximo (decisão do
 * dono no doc 311). Este arquivo prova, sem banco:
 *
 *   1. NOS DOIS SENTIDOS: sem a espera pedida, a decisão é a de sempre em todos
 *      os modos; com ela, rodízio e carga guardam o pedido até o prazo;
 *   2. o destino padrão do número ("direto para uma pessoa", #2331) e o modo
 *      manual NÃO esperam, com ou sem a opção;
 *   3. o prazo conta de quando a espera começou, vence, e o aviso sai uma vez;
 *   4. a leitura que responde "há IA atendendo?" usa a régua do MOTOR
 *      (`resolverAgenteDaConversa`) e falha ABERTA quando não consegue ler;
 *   5. a borda da rota aceita o prazo só dentro da faixa, e omitir não desliga.
 */
import { describe, expect, it } from "vitest";

import { decideRouting, type RoutingCandidate } from "@/lib/routing/decide";
import {
  lerEsperaPelaIA,
  lerQualificacaoDaIA,
  prazoDaEspera,
  qualificacaoEmCurso,
  silenciadoAgora,
  type ConversaParaQualificar,
} from "@/lib/routing/qualificacao-da-ia";
import {
  channelRoutingPatchSchema,
  ESPERA_PELA_IA_MAX_MINUTOS,
  ESPERA_PELA_IA_MIN_MINUTOS,
  routingConfigSchema,
} from "@/lib/schemas/routing";

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

const ATE = "2026-11-07T13:00:00.000Z";
const base = { alreadyAssigned: false, eligibles: [ANA], config, attempts: 0, now: NOW };

describe("decideRouting — a espera pela IA é opção, e não vence o destino do número (#3966)", () => {
  it("LIGADA: rodízio com elegível guarda o pedido até o prazo, sem distribuir", () => {
    expect(decideRouting({ ...base, mode: "round_robin", esperaPelaIAAte: ATE })).toEqual({
      kind: "wait_ai",
      nextAttemptAt: ATE,
    });
  });

  it("LIGADA: menor carga também espera", () => {
    expect(decideRouting({ ...base, mode: "load", esperaPelaIAAte: ATE })).toEqual({
      kind: "wait_ai",
      nextAttemptAt: ATE,
    });
  });

  it("⭐ DESLIGADA (ausente ou nula): a decisão é a de sempre, modo a modo", () => {
    for (const mode of ["round_robin", "load", "manual", "telefone"]) {
      for (const defaultAssigneeUserId of [null, "bruno"]) {
        const deSempre = decideRouting({ ...base, mode, defaultAssigneeUserId });
        expect(decideRouting({ ...base, mode, defaultAssigneeUserId, esperaPelaIAAte: null })).toEqual(deSempre);
      }
    }
    expect(decideRouting({ ...base, mode: "round_robin" })).toEqual({ kind: "assign", userId: "ana" });
    expect(decideRouting({ ...base, mode: "round_robin", eligibles: [] }).kind).toBe("requeue");
  });

  it("⭐ o destino padrão do NÚMERO não espera: com a opção ligada, entrega como na main (#2331)", () => {
    for (const mode of ["manual", "round_robin", "load"]) {
      const comEspera = decideRouting({ ...base, mode, defaultAssigneeUserId: "bruno", esperaPelaIAAte: ATE });
      expect(comEspera).toEqual({ kind: "assign", userId: "bruno" });
      expect(comEspera).toEqual(decideRouting({ ...base, mode, defaultAssigneeUserId: "bruno" }));
    }
  });

  it("modo manual não espera: onde não há distribuição automática não há o que adiar", () => {
    expect(decideRouting({ ...base, mode: "manual", esperaPelaIAAte: ATE })).toEqual({
      kind: "skip",
      reason: "manual_mode",
    });
  });

  it("o caso que não pede humano continua vencendo — é dele a palavra final", () => {
    expect(
      decideRouting({ ...base, mode: "round_robin", motivoDoCaso: "caso_aguardando_cliente", esperaPelaIAAte: ATE }),
    ).toEqual({ kind: "skip", reason: "caso_aguardando_cliente" });
  });

  it("conversa que já tem dono não espera nem é reatribuída", () => {
    expect(
      decideRouting({ ...base, mode: "round_robin", alreadyAssigned: true, esperaPelaIAAte: ATE }),
    ).toEqual({ kind: "skip", reason: "already_assigned" });
  });
});

describe("prazoDaEspera — o prazo máximo, contado de quando a espera começou", () => {
  it("primeira vez: começa agora e vence daqui a N minutos", () => {
    expect(prazoDaEspera(null, NOW, 60)).toEqual({
      desde: "2026-11-07T12:00:00.000Z",
      ate: "2026-11-07T13:00:00.000Z",
      vencida: false,
      avisada: false,
    });
  });

  it("não reinicia: a marca antiga manda, e o prazo vence no minuto exato", () => {
    const marca = { desde: "2026-11-07T11:00:00.000Z" };
    expect(prazoDaEspera(marca, new Date("2026-11-07T11:59:59Z"), 60).vencida).toBe(false);
    expect(prazoDaEspera(marca, NOW, 60)).toMatchObject({ ate: "2026-11-07T12:00:00.000Z", vencida: true, avisada: false });
  });

  it("o aviso já dado é lembrado — não se repete a cada nova tentativa", () => {
    expect(prazoDaEspera({ desde: "2026-11-07T10:00:00.000Z", avisada: true }, NOW, 60)).toMatchObject({
      vencida: true,
      avisada: true,
    });
  });

  it("lerEsperaPelaIA não confia na forma do metadata", () => {
    expect(lerEsperaPelaIA(null)).toBeNull();
    expect(lerEsperaPelaIA({})).toBeNull();
    expect(lerEsperaPelaIA({ espera_pela_ia: null })).toBeNull();
    expect(lerEsperaPelaIA({ espera_pela_ia: { desde: "não-é-data" } })).toBeNull();
    expect(lerEsperaPelaIA({ espera_pela_ia: { desde: "2026-11-07T11:00:00.000Z", avisada: "sim" } })).toEqual({
      desde: "2026-11-07T11:00:00.000Z",
      avisada: false,
    });
    expect(lerEsperaPelaIA({ espera_pela_ia: { desde: "2026-11-07T11:00:00.000Z", avisada: true } })).toEqual({
      desde: "2026-11-07T11:00:00.000Z",
      avisada: true,
    });
  });
});

describe("a borda: o prazo da espera no corpo da regra do número", () => {
  const corpo = { channel_session_id: "20000000-0000-4000-8000-000000000002", user_ids: [] };

  it("omitido fica omitido — um cliente antigo não desliga a espera por omissão", () => {
    expect(channelRoutingPatchSchema.parse(corpo).ai_wait_minutes).toBeUndefined();
  });

  it("nulo desliga; dentro da faixa liga; fora da faixa é recusado", () => {
    expect(channelRoutingPatchSchema.parse({ ...corpo, ai_wait_minutes: null }).ai_wait_minutes).toBeNull();
    for (const ok of [ESPERA_PELA_IA_MIN_MINUTOS, 1440, ESPERA_PELA_IA_MAX_MINUTOS]) {
      expect(channelRoutingPatchSchema.parse({ ...corpo, ai_wait_minutes: ok }).ai_wait_minutes).toBe(ok);
    }
    for (const ruim of [0, ESPERA_PELA_IA_MIN_MINUTOS - 1, ESPERA_PELA_IA_MAX_MINUTOS + 1, 60.5, "60"]) {
      expect(channelRoutingPatchSchema.safeParse({ ...corpo, ai_wait_minutes: ruim }).success).toBe(false);
    }
  });
});

describe("qualificacaoEmCurso — as quatro condições", () => {
  const fatos = { iaAtendeOCanal: true, passouParaHumano: false, agenteCalado: false, comHumano: false };

  it("agente no ar, sem handoff, sem silêncio ⇒ qualificando", () => {
    expect(qualificacaoEmCurso(fatos)).toBe(true);
  });

  it("sem agente atendendo o número ⇒ distribui (quem nunca teve IA não espera)", () => {
    expect(qualificacaoEmCurso({ ...fatos, iaAtendeOCanal: false })).toBe(false);
  });

  it("handoff gravado ⇒ a qualificação terminou e a conversa entra na fila", () => {
    expect(qualificacaoEmCurso({ ...fatos, passouParaHumano: true })).toBe(false);
  });

  it("agente calado (pausa manual) não é qualificação em curso", () => {
    expect(qualificacaoEmCurso({ ...fatos, agenteCalado: true })).toBe(false);
  });

  it("conversa com humano não é assunto da IA", () => {
    expect(qualificacaoEmCurso({ ...fatos, comHumano: true })).toBe(false);
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
