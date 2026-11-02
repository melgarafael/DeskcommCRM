import { describe, expect, it } from "vitest";

import { detectHumanHandoffRequest } from "@/lib/agent-engine/agent/human-handoff";
import { deveAbrirCasoDoFailsafe } from "@/lib/agent-engine/guardrails/failsafe-do-caso";
import {
  detectHumanHandoffPromise,
  detectHumanPromise,
} from "@/lib/agent-engine/guardrails/human-promise";
import { textoDoAviso, type MotivoDoAviso } from "@/lib/escalacao/aviso-ao-lead";
import { lerFraseDoAvisoConfigurada } from "@/lib/escalacao/frase-do-aviso-configurada";
import { MENSAGENS_NO_RESUMO, montarResumoDoCaso } from "@/lib/escalacao/resumo-do-caso";

/**
 * Issue #3725 — os TRÊS pontos, medidos.
 *
 * (a) FALSO POSITIVO — o fail-safe de `case_promise_without_case` abria caso
 *     humano (e o cliente lia "passei seu pedido para um atendente humano")
 *     quando o cliente só havia respondido "Não" a uma pergunta de horário. A
 *     promessa que disparava era de RETOMADA ("nossa equipe te responde outro
 *     dia"), não de passagem. A régua agora exige pedido explícito do cliente
 *     OU promessa explícita de envolver alguém agora.
 *
 * (b) SUMMARY — o caso nascia com `summary = body`, a mensagem que a IA tentou
 *     enviar. Quem abria a Central via uma fala solta do robô, sem o que o
 *     cliente havia dito. Agora o resumo vem da conversa, alternando papéis.
 *
 * (c) TEXTO — a frase padrão do motivo genérico era "Prefiro não arriscar aqui:
 *     passei seu pedido para um atendente humano." Ela sai do default (curto e
 *     humano no lugar) e passa a ser sobrescrevível pela configuração que o
 *     agente JÁ tem: `ai_agents.config.aviso_de_handoff`, sem migration.
 */

const CONVERSA_DO_NAO = [
  { direction: "outbound", body: "Tem algum dia ou período melhor para o contato?" },
  { direction: "inbound", body: "Não" },
] as const;

/** A fala que, com a conversa acima, abria caso humano na `main`. */
const PROMESSA_DE_RETOMADA = "Sem problema! Nossa equipe vai te responder outro dia.";

describe("#3725 (a) — resposta curta de sim/não não é pedido de humano", () => {
  it.each([
    "Não",
    "não",
    "Não.",
    "Não sei",
    "Depois",
    "Agora não",
    "Não, obrigado",
    "Pode ser",
    "Sim",
    "Ok",
  ])("o detector de pedido não casa %j", (resposta) => {
    expect(detectHumanHandoffRequest(resposta)).toBe(false);
  });

  it("a conversa do 'Não' NÃO abre caso de fail-safe (hoje abre)", () => {
    expect(lerFraseDoAvisoConfigurada({})).toBeNull(); // controle: sem config, padrão
    expect(
      deveAbrirCasoDoFailsafe({
        mensagens: CONVERSA_DO_NAO,
        corpo: PROMESSA_DE_RETOMADA,
      }),
    ).toBe(false);
  });

  it("a promessa de retomada continua sendo PROMESSA (o gate tem de vetar), mas não abre caso", () => {
    // Contrato em duas partes: o detector amplo segue vetando o envio…
    expect(detectHumanPromise(PROMESSA_DE_RETOMADA)).toBe(true);
    // …e o fail-safe não transforma retomada em passagem para humano.
    expect(detectHumanHandoffPromise(PROMESSA_DE_RETOMADA)).toBe(false);
  });

  it("'quero falar com uma pessoa' ABRE caso de fail-safe", () => {
    expect(
      deveAbrirCasoDoFailsafe({
        mensagens: [
          { direction: "outbound", body: "Tem algum dia ou período melhor para o contato?" },
          { direction: "inbound", body: "quero falar com uma pessoa" },
        ],
        corpo: "Claro! Já estou chamando alguém.",
      }),
    ).toBe(true);
  });

  it("promessa explícita da IA ABRE caso mesmo sem pedido do cliente", () => {
    for (const corpo of [
      "Já encaminhei para a equipe.",
      "Vou transferir para o setor responsável.",
      "Passei seu pedido para um atendente humano agora.",
    ]) {
      expect(
        deveAbrirCasoDoFailsafe({
          mensagens: CONVERSA_DO_NAO,
          corpo,
        }),
        corpo,
      ).toBe(true);
    }
  });

  it("oferta de humano não abre caso (é pergunta, não promessa)", () => {
    expect(
      deveAbrirCasoDoFailsafe({
        mensagens: CONVERSA_DO_NAO,
        corpo: "Entendi! Quer que eu encaminhe para a equipe?",
      }),
    ).toBe(false);
  });
});

describe("#3725 (b) — o summary do caso vem da conversa", () => {
  const conversa = [
    { direction: "outbound", body: "Tem algum dia ou período melhor para o contato?" },
    { direction: "inbound", body: "Não" },
    { direction: "outbound", body: "Sem problema! Nossa equipe te responde outro dia." },
  ];

  it("contém as DUAS partes da conversa", () => {
    const resumo = montarResumoDoCaso(conversa, "promessa de humano sem caso aberto");
    expect(resumo).toContain("Cliente: Não");
    expect(resumo).toContain("Atendimento: Tem algum dia ou período melhor para o contato?");
    expect(resumo).toContain("Nossa equipe te responde outro dia");
  });

  it("não é a última fala da IA repetida", () => {
    const resumo = montarResumoDoCaso(conversa, "promessa de humano sem caso aberto");
    expect(resumo).not.toBe(conversa[2]!.body);
    expect(resumo.trim().startsWith("Sem problema!")).toBe(false);
  });

  it("leva o motivo no fim e respeita a janela de mensagens", () => {
    const longa = Array.from({ length: 12 }, (_, i) => ({
      direction: i % 2 === 0 ? "inbound" : "outbound",
      body: `fala ${i}`,
    }));
    const resumo = montarResumoDoCaso(longa, "a IA prometeu humano sem caso aberto");
    expect(resumo).toContain("Motivo: a IA prometeu humano sem caso aberto");
    expect(resumo).not.toContain("fala 0");
    expect(resumo.split("\n").filter((l) => l.includes(": fala")).length).toBe(
      MENSAGENS_NO_RESUMO,
    );
  });
});

describe("#3725 (c) — frase do aviso: default humano e sobrescrita por configuração", () => {
  const MOTIVOS: readonly MotivoDoAviso[] = ["outro", "pediu_humano", "orcamento_de_ia"];

  it("o padrão não carrega mais a frase robótica, em nenhum motivo nem lead", () => {
    const textos = MOTIVOS.flatMap((motivo) =>
      Array.from({ length: 40 }, (_, i) =>
        textoDoAviso(motivo, { disponiveis: 1, total: 1 } as never, `lead-${i}`),
      ),
    );
    for (const t of textos) expect(t).not.toContain("Prefiro não arriscar");
  });

  it("a configuração do agente sobrescreve a frase inteira", () => {
    const config = { aviso_de_handoff: "  Já chamei o time,  pode ficar tranquilo!  " };
    const frase = lerFraseDoAvisoConfigurada(config);
    expect(frase).toBe("Já chamei o time, pode ficar tranquilo!");
    expect(textoDoAviso("outro", { disponiveis: 1, total: 1 } as never, "lead-1", "pt-BR", frase)).toBe(
      "Já chamei o time, pode ficar tranquilo!",
    );
  });

  it("configuração inválida não vira frase: o padrão continua valendo", () => {
    for (const config of [
      null,
      {},
      { aviso_de_handoff: "" },
      { aviso_de_handoff: "  " },
      { aviso_de_handoff: "..." },
      { aviso_de_handoff: "x".repeat(400) },
      { aviso_de_handoff: 42 },
    ]) {
      expect(lerFraseDoAvisoConfigurada(config), JSON.stringify(config)).toBeNull();
    }
    expect(textoDoAviso("outro", null, "lead-1", "pt-BR", null)).not.toBe("");
  });
});
