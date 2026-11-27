import { describe, expect, it } from "vitest";

import {
  applyReactivityEvent,
  EVENTO_DE_ROBO_IGNORADO,
  type InicioDaConversa,
  type LiveEnrollmentRef,
  type ReactivityAdminClient,
} from "./reactivity";
import type { EnrollmentPatch } from "./engine";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "77777777-7777-4777-8777-777777777777";
const MENSAGEM = "44444444-4444-4444-8444-444444444444";
const OUTRA_MENSAGEM = "88888888-8888-4888-8888-888888888888";
const ABERTURA_EM = "2026-11-25T18:00:00.000Z";
const AGORA = "2026-11-25T18:10:00.000Z";

/** `segundos` depois da nossa abertura. */
function depois(segundos: number): string {
  return new Date(Date.parse(ABERTURA_EM) + segundos * 1000).toISOString();
}

/** Conversa aberta por NÓS; a primeira resposta dela é `primeiraId`, `segundos` depois. */
function abertaPorNos(segundos: number, primeiraId = MENSAGEM): InicioDaConversa {
  return {
    abertura: { direction: "outbound", sent_at: ABERTURA_EM },
    primeiraResposta: { id: primeiraId, sent_at: depois(segundos) },
  };
}

interface Espiao {
  eventos: Array<{ event_type: string; enrollment_id: string; idempotency_key: string }>;
  patches: Array<{ id: string; patch: EnrollmentPatch }>;
}

function montarDb(
  inscricoes: LiveEnrollmentRef[],
  inicio: InicioDaConversa | null,
): { db: ReactivityAdminClient; espiao: Espiao } {
  const espiao: Espiao = { eventos: [], patches: [] };

  const db: ReactivityAdminClient = {
    async loadConversationContactId() {
      return CONTATO;
    },
    async loadContactBlocked() {
      return false;
    },
    async loadLiveEnrollmentsForContact(_org, _contato, statuses) {
      const permitidos = statuses ?? ["active", "waiting_reply", "paused_handoff"];
      return inscricoes.filter((e) => permitidos.includes(e.status));
    },
    async insertEnrollmentEvent(event) {
      espiao.eventos.push({
        event_type: event.event_type,
        enrollment_id: event.enrollment_id,
        idempotency_key: event.idempotency_key,
      });
      return { inserted: true };
    },
    async updateEnrollment(id, _org, patch) {
      espiao.patches.push({ id, patch });
    },
    async agoraNoBanco() {
      return AGORA;
    },
  };
  if (inicio !== null) db.loadInicioDaConversa = async () => inicio;

  return { db, espiao };
}

function inscricao(over: Partial<LiveEnrollmentRef> = {}): LiveEnrollmentRef {
  return {
    id: "enr-1",
    status: "waiting_reply",
    current_node_id: "w1",
    steps_taken: 1,
    pointer_id: "ptr-1",
    handoff_policy: "pause",
    trigger_config: { kind: "lead_created", cancel_on_reply: true },
    ...over,
  };
}

function eventoInbound(bodyPreview: string): EventRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    organization_id: ORG,
    event_type: "message.received",
    entity_kind: "message",
    entity_id: null,
    payload: {
      contact_id: CONTATO,
      conversation_id: CONVERSA,
      message_id: MENSAGEM,
      direction: "inbound",
      body_preview: bodyPreview,
    },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

async function reagir(texto: string, inicio: InicioDaConversa | null, over: Partial<LiveEnrollmentRef> = {}) {
  const { db, espiao } = montarDb([inscricao(over)], inicio);
  const res = await applyReactivityEvent(db, () => new Date(AGORA), eventoInbound(texto));
  return { res, espiao };
}

/** As 17 respostas de cliente do corpus da issue 5262 (triagem do PR 5269). */
const CLIENTES = [
  "1. qual o preço?\n2. qual o prazo?",
  "Tenho duas dúvidas:\n1) valor\n2) prazo de entrega",
  "Não entendi qual a opção desejada, pode explicar?",
  "Escolha a opção mais barata pra mim",
  "Me manda o menu de opções de vocês",
  "1 - quanto custa\n2 - vocês atendem sábado?",
  "Oi! Quero saber:\n1. preço\n2. formas de pagamento\n3. prazo",
  "Opção 1 e opção 2 me interessam",
  "Prefiro a 2) mesmo",
  "Bom dia, recebi sua mensagem. Sou a Ana, responsável pelas compras. Podemos conversar amanhã?",
  "Tenho interesse sim! Seguem minhas perguntas:\n1 - Tem garantia?\n2 - Entrega em SP?",
  "Digite o número do pedido que eu confiro? kkk brincadeira, qual o valor?",
  "Quero o plano 1, mas antes:\n2) aceita pix?",
  "Pode ser. 1) Segunda de manhã 2) Terça à tarde, qual fica melhor?",
  "Gostaria de saber mais.\n1- Valores\n2- Horários",
  "Seleciona a opção de pagamento no boleto pra mim por favor",
  "Recebi. Meu horário é 1. manhã ou 2. noite",
];

/** Os robôs do corpus. Os três primeiros são os exemplos da própria issue. */
const ROBOS = [
  "A Clínica X agradece seu contato. Como podemos ajudar?",
  "Seja bem-vindo(a)! Em breve responderemos.",
  "1 - Serviços, 2 - Valores",
  "1 - Serviços\n2 - Valores",
  "Olá! Esta é uma mensagem automática. Retornaremos em breve.",
  "Digite o número da opção desejada:\n1 - Agendar\n2 - Resultados\n3 - Falar com atendente",
  "Olá, sou o assistente virtual da Loja Y. Como posso ajudar?",
  "Obrigado por entrar em contato! Nosso horário de atendimento é de seg a sex, das 8h às 18h. Retornaremos assim que possível.",
];

/** Os que se reconhecem pelo TEXTO, a qualquer hora (doc 422, sinais seguros). */
const ROBOS_PELO_TEXTO = [
  "Olá! Esta é uma mensagem automática. Retornaremos em breve.",
  "Digite o número da opção desejada:\n1 - Agendar\n2 - Resultados\n3 - Falar com atendente",
  "Olá, sou o assistente virtual da Loja Y. Como posso ajudar?",
];

function esperaCancelada(espiao: Espiao) {
  expect(espiao.patches[0]?.patch.status).toBe("cancelled");
  expect(espiao.patches[0]?.patch.outcome).toBe("replied");
  expect(espiao.eventos.map((e) => e.event_type)).not.toContain(EVENTO_DE_ROBO_IGNORADO);
}

function esperaIgnorada(espiao: Espiao, reacted: number) {
  expect(reacted).toBe(0);
  expect(espiao.patches).toEqual([]);
  expect(espiao.eventos.map((e) => e.event_type)).toEqual([EVENTO_DE_ROBO_IGNORADO]);
}

describe("reatividade — resposta automática de robô em cancel_on_reply (#5262, doc 422 = B)", () => {
  it.each(ROBOS)("robô na primeira resposta, 5 s depois da nossa abertura, não cancela: %j", async (texto) => {
    const { res, espiao } = await reagir(texto, abertaPorNos(5));
    esperaIgnorada(espiao, res.reacted);
  });

  it.each(CLIENTES)("cliente que responde 5 min depois da abertura cancela: %j", async (texto) => {
    const { res, espiao } = await reagir(texto, abertaPorNos(300));
    expect(res.reacted).toBe(1);
    esperaCancelada(espiao);
  });

  it.each(CLIENTES)("cliente rápido: a SEGUNDA mensagem, ainda no primeiro minuto, cancela: %j", async (texto) => {
    const { res, espiao } = await reagir(texto, abertaPorNos(3, OUTRA_MENSAGEM));
    expect(res.reacted).toBe(1);
    esperaCancelada(espiao);
  });

  it("o custo aceito: a primeira resposta do cliente em menos de um minuto não cancela", async () => {
    const { res, espiao } = await reagir("Oi, pode me passar os valores?", abertaPorNos(40));
    esperaIgnorada(espiao, res.reacted);
  });

  it("61 s depois da abertura a janela já fechou", async () => {
    const { res, espiao } = await reagir("Seja bem-vindo(a)! Em breve responderemos.", abertaPorNos(61));
    expect(res.reacted).toBe(1);
    esperaCancelada(espiao);
  });

  it("conversa que o CONTATO abriu não tem janela: a resposta rápida cancela", async () => {
    const { res, espiao } = await reagir("1 - Serviços\n2 - Valores", {
      abertura: { direction: "inbound", sent_at: ABERTURA_EM },
      primeiraResposta: { id: MENSAGEM, sent_at: depois(5) },
    });
    expect(res.reacted).toBe(1);
    esperaCancelada(espiao);
  });

  it.each(ROBOS_PELO_TEXTO)("robô que se declara ou menu que pede a escolha não cancela nem fora da janela: %j", async (texto) => {
    const { res, espiao } = await reagir(texto, abertaPorNos(600, OUTRA_MENSAGEM));
    esperaIgnorada(espiao, res.reacted);
  });

  it("sem como ler o início da conversa, menu sem instrução cancela como antes", async () => {
    const { res, espiao } = await reagir("1 - Serviços\n2 - Valores", null);
    expect(res.reacted).toBe(1);
    esperaCancelada(espiao);
  });

  it("inscrição active com timer também não é cortada pelo robô", async () => {
    const { res, espiao } = await reagir("Seja bem-vindo(a)! Em breve responderemos.", abertaPorNos(5), {
      status: "active",
    });
    esperaIgnorada(espiao, res.reacted);
  });

  it("lê o corpo completo via message_id quando body_preview vem truncado em 280 chars", async () => {
    const corpoCompleto = `${"A".repeat(300)}\nDigite o número da opção:\n1 - Serviços\n2 - Valores`;
    const { db, espiao } = montarDb([inscricao()], abertaPorNos(600, OUTRA_MENSAGEM));
    db.loadMessageBody = async () => corpoCompleto;

    const res = await applyReactivityEvent(db, () => new Date(AGORA), eventoInbound(corpoCompleto.slice(0, 280)));

    esperaIgnorada(espiao, res.reacted);
  });

  it("não move o card de etapa (move_to_stage_on_reply) quando a resposta é de robô", async () => {
    const { res, espiao } = await reagir("1 - Serviços, 2 - Valores", abertaPorNos(5), {
      trigger_config: {
        kind: "stage_change",
        params: { stage_id: "55555555-5555-4555-8555-555555555555" },
        cancel_on_reply: true,
        move_to_stage_on_reply: "66666666-6666-4666-8666-666666666666",
      },
    });
    esperaIgnorada(espiao, res.reacted);
  });

  it("sem cancel_on_reply, nem pergunta ao banco: o inbound acorda a espera", async () => {
    const { db, espiao } = montarDb([inscricao({ trigger_config: { kind: "lead_created" } })], null);
    let consultas = 0;
    db.loadInicioDaConversa = async () => {
      consultas++;
      return abertaPorNos(5);
    };
    await applyReactivityEvent(db, () => new Date(AGORA), eventoInbound("Seja bem-vindo(a)!"));
    expect(consultas).toBe(0);
    expect(espiao.eventos.map((e) => e.event_type)).not.toContain(EVENTO_DE_ROBO_IGNORADO);
  });
});
