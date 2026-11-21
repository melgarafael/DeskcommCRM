/**
 * Retomar ao devolver — a DECISÃO e o AGENDAMENTO.
 *
 * Prende: o turno só é enfileirado com a opção ligada E a última fala da equipe
 * E sem follow-up vivo E com o contato liberado para a IA; o job leva a sessão
 * e a fronteira atual; e o mesmo evento
 * entregue duas vezes não gera dois turnos.
 *
 * NÃO prova: nada com Postgres real (dublê de porta) nem o turno do worker —
 * esse está em `tests/unit/retomada-ao-devolver-no-turno.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

import { falasDaEquipeNoFim, ultimaFalaEDaEquipe } from "./fala-da-equipe";
import {
  agendarRetomadaAoDevolver,
  decidirRetomadaAoDevolver,
  lerRetomarAoDevolver,
  opcaoDoAgenteDaConversa,
  type AgenteComVersao,
  type FatosDaRetomada,
  type RetomadaAoDevolverDb,
} from "./retomada-ao-devolver";

const ORG = "org-1";
const CONVERSA = "conversa-1";
const CONTATO = "contato-1";
const SESSAO = "sessao-1";
const EVENTO = "evento-1";

const FALA_DA_EQUIPE = { direction: "outbound", sent_via: "crm" };

const fronteira = {
  organization_id: ORG,
  contact_id: CONTATO,
  conversation_id: CONVERSA,
  service_revision: 3,
  demanda_id: null,
  demanda_revision: null,
};

function fatos(p: Partial<FatosDaRetomada> = {}): FatosDaRetomada {
  return {
    opcaoLigada: true,
    ultima: FALA_DA_EQUIPE,
    acompanhamentoVivo: false,
    humanoNoComando: false,
    contatoForaDaIA: false,
    ...p,
  };
}

describe("a régua da fala da equipe", () => {
  it("Inbox do CRM, usuário e aparelho conectado são a equipe; IA, automação e sistema não", () => {
    for (const via of ["crm", "user", "external_device"]) {
      expect(ultimaFalaEDaEquipe({ direction: "outbound", sent_via: via }), via).toBe(true);
    }
    for (const via of ["ai", "automation", "system", null]) {
      expect(ultimaFalaEDaEquipe({ direction: "outbound", sent_via: via }), String(via)).toBe(false);
    }
  });

  it("a mensagem do cliente nunca é fala da equipe, e conversa vazia também não", () => {
    expect(ultimaFalaEDaEquipe({ direction: "inbound", sent_via: "crm" })).toBe(false);
    expect(ultimaFalaEDaEquipe(null)).toBe(false);
  });

  it("as falas do fim saem em ordem cronológica e param na primeira que não é da equipe", () => {
    const maisNovaPrimeiro = [
      { direction: "outbound", sent_via: "crm", id: "c" },
      { direction: "outbound", sent_via: "external_device", id: "b" },
      { direction: "inbound", sent_via: null, id: "cliente" },
      { direction: "outbound", sent_via: "crm", id: "antiga" },
    ];
    expect(falasDaEquipeNoFim(maisNovaPrimeiro).map((m) => m.id)).toEqual(["b", "c"]);
  });
});

describe("decidirRetomadaAoDevolver", () => {
  it("opção ligada, fala da equipe por último, sem follow-up vivo: retoma", () => {
    expect(decidirRetomadaAoDevolver(fatos())).toEqual({ retomar: true });
  });

  it.each([
    ["opção desligada (o padrão)", { opcaoLigada: false }, "opcao_desligada"],
    ["sem agente publicado", { opcaoLigada: null }, "sem_agente_publicado"],
    ["cliente escreveu por último", { ultima: { direction: "inbound", sent_via: null } }, "ultima_fala_nao_e_da_equipe"],
    ["IA falou por último", { ultima: { direction: "outbound", sent_via: "ai" } }, "ultima_fala_nao_e_da_equipe"],
    ["conversa sem mensagem", { ultima: null }, "sem_mensagens"],
    ["follow-up vivo (uma voz só)", { acompanhamentoVivo: true }, "acompanhamento_vivo"],
    ["alguém assumiu de novo", { humanoNoComando: true }, "humano_no_comando"],
    ["contato sempre humano/bloqueado", { contatoForaDaIA: true }, "contato_fora_da_ia"],
  ] as const)("%s: não retoma", (_nome, p, motivo) => {
    expect(decidirRetomadaAoDevolver(fatos(p as Partial<FatosDaRetomada>))).toEqual({ retomar: false, motivo });
  });
});

describe("lerRetomarAoDevolver: jsonb de versão antiga lê como desligado", () => {
  it("só `true` liga", () => {
    expect(lerRetomarAoDevolver({ resume_on_handback: true })).toBe(true);
    expect(lerRetomarAoDevolver({ resume_on_handback: "true" })).toBe(false);
    expect(lerRetomarAoDevolver({ events: ["message"] })).toBe(false);
    expect(lerRetomarAoDevolver(null)).toBe(false);
  });
});

function dbFalso(p: {
  opcao?: boolean | null;
  ultima?: { direction: string; sent_via: string | null } | null;
  vivo?: boolean;
  fronteira?: typeof fronteira | null;
  jaEnfileirado?: boolean;
} = {}) {
  const enfileiraTurno = vi.fn(async () => !p.jaEnfileirado);
  const db: RetomadaAoDevolverDb = {
    carregaConversa: vi.fn(async () => ({
      contactId: CONTATO,
      channelSessionId: SESSAO,
      activeAgentId: null,
      humanoNoComando: false,
    })),
    contatoForaDaIA: vi.fn(async () => false),
    opcaoDoAgente: vi.fn(async () => (p.opcao === undefined ? true : p.opcao)),
    ultimaMensagem: vi.fn(async () => (p.ultima === undefined ? FALA_DA_EQUIPE : p.ultima)),
    acompanhamentoVivo: vi.fn(async () => p.vivo ?? false),
    fronteiraAtual: vi.fn(async () => (p.fronteira === undefined ? fronteira : p.fronteira)),
    enfileiraTurno,
  };
  return { db, enfileiraTurno };
}

const entrada = { organizationId: ORG, conversationId: CONVERSA, eventId: EVENTO };

describe("agendarRetomadaAoDevolver", () => {
  it("enfileira UM followup_turn de retomada com a sessão, a fronteira e o evento de origem", async () => {
    const { db, enfileiraTurno } = dbFalso();
    expect(await agendarRetomadaAoDevolver(db, entrada)).toEqual({ kind: "enfileirado" });
    expect(enfileiraTurno).toHaveBeenCalledTimes(1);
    expect(enfileiraTurno).toHaveBeenCalledWith({
      organizationId: ORG,
      contactId: CONTATO,
      sourceEventId: EVENTO,
      payload: expect.objectContaining({
        mode: "retomada",
        conversation_id: CONVERSA,
        // a sessão do número viaja junto (o hold também a lê)
        channel_session_id: SESSAO,
        service_boundary: fronteira,
      }),
    });
  });

  it("opção desligada: nem lê a conversa adiante e não enfileira", async () => {
    const { db, enfileiraTurno } = dbFalso({ opcao: false });
    expect(await agendarRetomadaAoDevolver(db, entrada)).toEqual({ kind: "pulado", motivo: "opcao_desligada" });
    expect(db.ultimaMensagem).not.toHaveBeenCalled();
    expect(enfileiraTurno).not.toHaveBeenCalled();
  });

  it("cliente já escreveu depois da equipe: não enfileira (o turno de resposta cuida)", async () => {
    const { db, enfileiraTurno } = dbFalso({ ultima: { direction: "inbound", sent_via: null } });
    expect(await agendarRetomadaAoDevolver(db, entrada)).toEqual({
      kind: "pulado",
      motivo: "ultima_fala_nao_e_da_equipe",
    });
    expect(enfileiraTurno).not.toHaveBeenCalled();
  });

  it("follow-up vivo para o contato: cede a vez, não enfileira", async () => {
    const { db, enfileiraTurno } = dbFalso({ vivo: true });
    expect(await agendarRetomadaAoDevolver(db, entrada)).toEqual({ kind: "pulado", motivo: "acompanhamento_vivo" });
    expect(enfileiraTurno).not.toHaveBeenCalled();
  });

  it("sem fronteira de atendimento atual: não enfileira", async () => {
    const { db, enfileiraTurno } = dbFalso({ fronteira: null });
    expect(await agendarRetomadaAoDevolver(db, entrada)).toEqual({ kind: "pulado", motivo: "fronteira_ilegivel" });
    expect(enfileiraTurno).not.toHaveBeenCalled();
  });

  it("o mesmo evento entregue de novo vira `ja_enfileirado`, não um segundo turno", async () => {
    const { db } = dbFalso({ jaEnfileirado: true });
    expect(await agendarRetomadaAoDevolver(db, entrada)).toEqual({ kind: "ja_enfileirado" });
  });
});

describe("opcaoDoAgenteDaConversa: vale a opção de QUEM atenderia, nunca a do vizinho", () => {
  // Revisão do PR #5105: com `.some()` sobre todos os publicados no número, a
  // opção de um agente pausado ou de menor prioridade acordava o turno do outro.
  function agente(id: string, p: { prioridade?: number; pausado?: boolean; liga?: boolean; assistido?: boolean; sessao?: string | null; nasceu?: string }): AgenteComVersao {
    return {
      id,
      channel: "whatsapp",
      kind: "agent",
      is_active: true,
      paused_at: p.pausado ? "2026-11-20T10:00:00Z" : null,
      operation_mode: p.assistido ? "assisted" : "autonomous",
      published_version_id: `versao-${id}`,
      archived_at: null,
      priority: p.prioridade ?? 0,
      created_at: p.nasceu ?? "2026-01-01T00:00:00Z",
      versao: {
        status: "published",
        channel_session_id: p.sessao === undefined ? SESSAO : p.sessao,
        trigger_config: { resume_on_handback: p.liga === true },
      },
    };
  }
  const semGrude = { channelSessionId: SESSAO, activeAgentId: null };

  it("dois agentes no número: vale a opção do de MAIOR prioridade, não a do outro", () => {
    const atende = agente("a", { prioridade: 10, liga: false });
    const vizinho = agente("b", { prioridade: 1, liga: true });
    expect(opcaoDoAgenteDaConversa([vizinho, atende], semGrude)).toBe(false);
    // Controle: a opção do que ATENDE liga a retomada.
    expect(opcaoDoAgenteDaConversa([agente("b", { prioridade: 1 }), agente("a", { prioridade: 10, liga: true })], semGrude)).toBe(true);
  });

  it("agente PAUSADO com a opção ligada não acorda o turno do que está no ar", () => {
    const pausado = agente("p", { prioridade: 99, pausado: true, liga: true });
    const noAr = agente("n", { prioridade: 1, liga: false });
    expect(opcaoDoAgenteDaConversa([pausado, noAr], semGrude)).toBe(false);
  });

  it("o agente grudado na conversa decide, mesmo com outro de prioridade maior no número", () => {
    const grudado = agente("g", { prioridade: 1, liga: true, sessao: null });
    const maior = agente("m", { prioridade: 50, liga: false });
    expect(opcaoDoAgenteDaConversa([maior, grudado], { channelSessionId: SESSAO, activeAgentId: "g" })).toBe(true);
  });

  it("quem atende no modo assistido não retoma sozinho; sem agente, ninguém", () => {
    expect(opcaoDoAgenteDaConversa([agente("s", { liga: true, assistido: true })], semGrude)).toBeNull();
    expect(opcaoDoAgenteDaConversa([agente("x", { liga: true, sessao: "outro-numero" }), agente("y", { liga: true, sessao: "outro-numero" })], semGrude)).toBeNull();
  });
});
