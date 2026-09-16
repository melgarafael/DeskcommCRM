import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_VETOS_DE_FALSO_VAZIO,
  buildOpeningMessage,
  claimsCurrentInboundIsEmpty,
} from "@/lib/agent-engine/agent/inbound-turn";
import type { LeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";

describe("mensagem atual do cliente", () => {
  it("fica depois da memória anterior e vence um resumo contaminado", () => {
    const contexto: LeadContext = {
      lead_id: "11111111-1111-4111-8111-111111111111",
      contact: { name: "Cristiano", phone: null, email: null, tags: [], is_blocked: false, custom_fields: {} },
      conversation_id: "22222222-2222-4222-8222-222222222222",
      last_human_decision: null,
      messages: [
        {
          direction: "outbound",
          body: "Como posso ajudar?",
          sent_at: "2026-09-06T09:01:00-04:00",
        },
        {
          direction: "inbound",
          body: "Quero marcar um horário com a Drª Mara.",
          sent_at: "2026-09-06T09:03:00-04:00",
        },
      ],
    };

    const abertura = buildOpeningMessage(
      {
        commitments: [],
        objections: [],
        next_action: "aguardar a mensagem do cliente",
        rolling_summary: "A última mensagem do cliente veio em branco.",
      } as never,
      null,
      contexto,
      "sem notas",
    );

    expect(abertura).toContain("## Mensagem atual do cliente — fonte prioritária");
    expect(abertura).toContain('"texto":"Quero marcar um horário com a Drª Mara."');
    expect(abertura).toContain("NUNCA diga que veio vazia, em branco ou que não foi recebida.");
    expect(abertura.indexOf("A última mensagem do cliente veio em branco.")).toBeLessThan(
      abertura.indexOf("## Mensagem atual do cliente — fonte prioritária"),
    );
  });

  it("prefere a mensagem apontada pelo job a outra inbound no histórico", () => {
    const contexto: LeadContext = {
      lead_id: "11111111-1111-4111-8111-111111111111",
      contact: { name: "Cristiano", phone: null, email: null, tags: [], is_blocked: false, custom_fields: {} },
      conversation_id: "22222222-2222-4222-8222-222222222222",
      last_human_decision: null,
      messages: [
        { direction: "inbound", body: "registro concorrente sem conteúdo", sent_at: "2026-09-06T18:10:00-04:00" },
      ],
    };

    const abertura = buildOpeningMessage(null, null, contexto, "sem notas", false, [], "", "Quero agendar com a Drª Mara.");

    expect(abertura).toContain('"texto":"Quero agendar com a Drª Mara."');
    expect(abertura).not.toContain('"texto":"registro concorrente sem conteúdo"');
  });
});

describe("barreira contra falso aviso de mensagem vazia", () => {
  const inbound = "Eu quero agendar uma consulta com a Drª Mara, já tinha dito antes.";

  it.each([
    "Recebi uma mensagem em branco.",
    "Sua última mensagem veio sem texto.",
    "Notei que a mensagem chegou vazia.",
  ])("recusa a frase falsa: %s", (candidate) => {
    expect(claimsCurrentInboundIsEmpty(candidate, inbound)).toBe(true);
  });

  /**
   * O CORPUS MEDIDO — não é ilustração, é a prova de um defeito real.
   *
   * A primeira versão desta detecção aceitava `ela` como referência a "mensagem".
   * Rodado contra estas seis frases legítimas de atendimento, o regex vetava a
   * primeira: um pronome casa com qualquer sujeito feminino da frase, e "vazio"
   * é palavra corrente numa agenda. Ficam aqui nomeadas para que alargar a
   * referência de novo custe vermelho, em vez de custar um turno mudo.
   */
  it.each([
    // ⬇️ ESTA é a que disparava. Foi ela que tirou `ela` do regex.
    "Consegui uma vaga com a Drª Mara — ela ficou com a tarde vazia na quinta.",
    "A agenda dela está vazia na quinta, posso te encaixar às 15h?",
    "Vi aqui e a lista de espera está vazia, então dá pra marcar hoje mesmo.",
    "Sua ficha está sem texto no campo de observações — quer que eu preencha?",
    "Claro. Qual dia e período você prefere para a consulta?",
    "Perfeito, marquei para terça às 9h com a Drª Mara.",
  ])("deixa passar a frase legítima: %s", (candidate) => {
    expect(claimsCurrentInboundIsEmpty(candidate, inbound)).toBe(false);
  });

  it("não arma quando a mensagem de fato não tem texto", () => {
    expect(claimsCurrentInboundIsEmpty("Recebi uma mensagem em branco.", "   ")).toBe(false);
  });
});

/**
 * A função pura acima prova que a frase é RECONHECIDA. Não prova que ela é
 * BARRADA: a detecção só vale se estiver no único caminho que fala no canal.
 * Apagar o `if` de dentro de `send_message.execute` deixa os seis casos acima
 * verdes e devolve o produto ao estado em que o cliente recebe a frase falsa.
 */
describe("a barreira está no caminho do envio, não numa função de ninguém", () => {
  const FONTE = readFileSync(
    join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
    "utf8",
  );
  const corpoDoSend = (() => {
    const i = FONTE.indexOf("send_message: tool({");
    const j = FONTE.indexOf("update_lead_state: tool({", i);
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    return FONTE.slice(i, j);
  })();

  it("o veto roda dentro de send_message.execute", () => {
    expect(corpoDoSend).toMatch(/claimsCurrentInboundIsEmpty\(body, mensagemDoJob\)/);
    expect(corpoDoSend).toContain("'false_empty_inbound'");
  });

  it("o veto tem TETO — persistir solta o envio, com registro", () => {
    // Sem teto o contador só subia, e um falso positivo teimoso calava o turno
    // inteiro: o cliente ficava sem resposta por causa de uma frase NOSSA. O
    // padrão da casa é `MAX_VETOS_DE_VOCABULARIO_INTERNO` — 1ª vez ensina, a 2ª
    // decide —, e soltar sem registrar seria trocar um erro visível por um mudo.
    expect(corpoDoSend).toMatch(/falseEmptyInboundVetoCount \+= 1/);
    expect(corpoDoSend).toMatch(/falseEmptyInboundVetoCount < MAX_VETOS_DE_FALSO_VAZIO/);
    expect(corpoDoSend).toMatch(
      /runLog\.warn\(\s*'fail-safe do gate de falso-vazio[\s\S]{0,160}?vetos: falseEmptyInboundVetoCount/,
    );
  });

  it("o teto deixa ao menos UMA chance de reescrita antes de soltar", () => {
    // 1 significaria "veta e já solta": o modelo nunca veria o erro instrutivo e
    // a barreira viraria telemetria. Mesmo degrau do gate de vocabulário interno.
    expect(MAX_VETOS_DE_FALSO_VAZIO).toBeGreaterThanOrEqual(2);
  });

  it("ele veta ANTES do teto de envios — recusa de conteúdo não gasta a cota do turno", () => {
    // A ordem é o que garante "não gasta envio": um veto que rodasse depois do
    // gate de `seq` já teria consumido a decisão de enviar do turno.
    //
    // ⚠️ A checagem de posição vem DEPOIS da de presença, e não é estilo: ao
    // sabotar o conserto (apagando o `if` inteiro de `send_message.execute`) a
    // primeira versão deste caso ficou VERDE, porque `indexOf` de algo ausente é
    // −1 e −1 é menor que qualquer posição. Uma ordem se satisfazia pela
    // ausência do que devia estar ordenado. Previsto 2 vermelhos, observado 1.
    const veto = corpoDoSend.indexOf("claimsCurrentInboundIsEmpty");
    const teto = corpoDoSend.indexOf("max_sends_per_turn");
    expect(veto).toBeGreaterThan(-1);
    expect(teto).toBeGreaterThan(-1);
    expect(veto).toBeLessThan(teto);
  });
});
