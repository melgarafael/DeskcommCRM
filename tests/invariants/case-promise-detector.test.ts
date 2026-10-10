import { describe, expect, it } from "vitest";

import { detectHumanPromise } from "@/lib/agent-engine/guardrails/human-promise";

/**
 * Wave 4 (spec 15 §10.2) — calibração do detector de promessa-de-humano. É o
 * ponto sensível do guardrail anti-alucinação: FALSO-POSITIVO trava o bot em
 * conversa legítima; FALSO-NEGATIVO deixa passar promessa sem caso (o fail-safe
 * cobre, mas o custo é abrir caso desnecessário). Estes casos são CONGELADOS
 * (tests/invariants) — regressão na regex quebra o CI. Puro (sem DB): não lê
 * TEST_DB_CONTAINER, roda na suíte db sem tocar o Postgres.
 */

// DEVE detectar: promessa clara de envolver retaguarda humana/equipe/setor.
const PROMISES: readonly string[] = [
  "vou verificar com a equipe",
  "nosso time vai resolver isso",
  "assim que liberarem eu te aviso",
  "vou acionar o responsável",
  "vou encaminhar pro setor responsável",
  "deixa eu falar com o pessoal do suporte",
  "vou passar pro nosso time técnico",
  "um responsável vai te retornar",
  "vou pedir pra equipe liberar",
  "isso quem resolve é o nosso time",
  // achado na prova E2E real (Wave 7, modelo anthropic real): alvo humano retomado por
  // PRONOME em vez do substantivo — "Já passo o número do pedido (#48291) para eles
  // resolverem junto com a reativação da assinatura."
  "já passo o número do pedido para eles resolverem junto com a reativação",
  // achado num tenant de produção (2026-08-30): ESTADO
  // passivo alegado, não promessa de ação futura — o agente respondeu a uma
  // reclamação de garantia de quase 1 dia dizendo isto sem NENHUM caso aberto.
  // As regras de "vai resolver"/"vou encaminhar" não cobrem uma AFIRMAÇÃO de que
  // já está em curso.
  "sua solicitação sobre garantia está em análise pela equipe responsável",
  "isso está em análise pela nossa equipe",
  "seu caso ficou em análise com o responsável",
];

// NÃO detectar: ação própria do bot / frase institucional / checar SISTEMA (≠ humano).
const NON_PROMISES: readonly string[] = [
  "vou te enviar o link",
  "vou confirmar o valor pra você",
  "deixa eu ver aqui rapidinho",
  "vou preparar seu orçamento",
  "já te mando o boleto",
  "vou verificar seu pedido no sistema",
  "nossa equipe está sempre à disposição",
  "vou anotar aqui",
  // pronome sem verbo de resolução depois — só "passar pra eles" não é promessa de AÇÃO.
  "vou passar o recado pra eles mais tarde",
  // "análise" em outro sentido (exame médico), não alegação de time humano cuidando.
  "sua análise de sangue está pronta",
  // "em análise" sem NOMEAR quem — conservador de propósito, mesmo raciocínio das
  // outras regras (exige TARGET explícito pra reduzir falso positivo).
  "o produto está em análise técnica interna, sem previsão",
];

describe("detectHumanPromise — calibração (spec 15 §10.2)", () => {
  it.each(PROMISES)("DETECTA promessa de humano: %s", (body) => {
    expect(detectHumanPromise(body)).toBe(true);
  });

  it.each(NON_PROMISES)("NÃO detecta (fala legítima): %s", (body) => {
    expect(detectHumanPromise(body)).toBe(false);
  });

  it("é robusto a caixa e acento (normaliza antes de casar)", () => {
    expect(detectHumanPromise("VOU VERIFICAR COM A EQUIPE")).toBe(true);
    expect(detectHumanPromise("vou acionar o RESPONSAVEL")).toBe(true);
  });

  it("no-op em string vazia", () => {
    expect(detectHumanPromise("")).toBe(false);
  });
});

/**
 * `extraHumanNames` — o alvo TARGET original só conhece cargos genéricos
 * (equipe/gerente/responsável/...), então um prompt de tenant que nomeia a
 * retaguarda por NOME PRÓPRIO ("vou confirmar com o Fulano") escapava 100% do
 * detector. Medido num tenant de produção: dezenas de promessas nomeando
 * o gerente pelo nome, 1 só detecção em 3 dias. A fonte real é
 * `ai_agent_versions.handoff_keywords` (já inclui o nome, ver `inbound-turn.ts`).
 */
describe("detectHumanPromise — extraHumanNames (nome próprio do tenant)", () => {
  const HANDOFF_KEYWORDS = ["falar com humano", "atendente", "pessoa real", "fulano", "gerente"];

  it("SEM extraHumanNames, 'vou confirmar com o Fulano' NÃO é detectada (o defeito medido)", () => {
    expect(detectHumanPromise("vou confirmar com o Fulano a disponibilidade de segunda")).toBe(false);
  });

  it("COM extraHumanNames (handoff_keywords do tenant), a mesma frase É detectada", () => {
    expect(
      detectHumanPromise("vou confirmar com o Fulano a disponibilidade de segunda", HANDOFF_KEYWORDS),
    ).toBe(true);
  });

  it("cobre as variantes reais do incidente: 'vou verificar com o Fulano' e 'encaminhar para o Fulano'", () => {
    expect(detectHumanPromise("vou verificar com o Fulano e te retorno", HANDOFF_KEYWORDS)).toBe(true);
    expect(detectHumanPromise("vou encaminhar essa questão ao Fulano", HANDOFF_KEYWORDS)).toBe(true);
  });

  it("é robusto a caixa e acento no nome extra também", () => {
    expect(detectHumanPromise("vou falar com o FULANO", HANDOFF_KEYWORDS)).toBe(true);
  });

  it("palavras compostas do handoff_keywords ('falar com humano', 'pessoa real') não quebram a montagem do regex", () => {
    // Só nomes próprios simples (uma palavra alfabética) entram no alvo estendido —
    // frases compostas são descartadas silenciosamente, não viram regex inválido.
    expect(() => detectHumanPromise("qualquer coisa", HANDOFF_KEYWORDS)).not.toThrow();
  });

  it("cargo já coberto por TARGET_WORDS ('gerente', 'atendente') não duplica o alvo nem muda o resultado padrão", () => {
    expect(detectHumanPromise("vou verificar com o gerente", HANDOFF_KEYWORDS)).toBe(true);
    expect(detectHumanPromise("vou verificar com o gerente")).toBe(true);
  });

  it("extraHumanNames vazio ou ausente preserva exatamente o comportamento anterior", () => {
    expect(detectHumanPromise("vou verificar com a equipe", [])).toBe(true);
    expect(detectHumanPromise("vou confirmar o valor pra você", [])).toBe(false);
  });

  it("nome extra não vira falso positivo em texto que só MENCIONA o nome sem prometer nada", () => {
    expect(detectHumanPromise("o Fulano é o nosso gerente de oficina", HANDOFF_KEYWORDS)).toBe(false);
  });
});


describe("consentimento para transferência não é operação executada", () => {
  it.each([
    "Você quer que eu te transfira para a equipe verificar?",
    "Posso falar com o responsável para você?",
    "Gostaria de ser encaminhado para o setor?",
    "Quer que eu verifique com a equipe?",
  ])("não exige caso antes de aceitar: %s", (body) => {
    expect(detectHumanPromise(body)).toBe(false);
  });
  it.each([
    "Já transferi para a equipe. Você quer continuar?",
    "Vou encaminhar para o setor. Você quer?",
    "Quer que eu te transfira? Nossa equipe vai retornar hoje.",
    "Você quer falar com a equipe que já acabei de chamar?",
  ])("conserva promessa independente: %s", (body) => {
    expect(detectHumanPromise(body)).toBe(true);
  });
});
