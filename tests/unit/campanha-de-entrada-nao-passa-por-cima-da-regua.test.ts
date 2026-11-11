import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { decidirElegibilidade, type EstadoDeElegibilidade } from "@/lib/ai/elegibilidade/gate";

/**
 * O AGENTE DA CAMPANHA DE ENTRADA NÃO PASSA POR CIMA DA RÉGUA (#4024).
 *
 * ─── O risco ────────────────────────────────────────────────────────────────
 *
 * Quem chega pela frase do anúncio já era ELEGÍVEL (o match autoriza a IA). O
 * que esta entrega acrescenta é *quem* responde o primeiro turno — e o jeito de
 * ela virar defeito grave é o degrau novo decidir por conta própria, no lugar da
 * régua de elegibilidade: dono humano, "sempre atendimento humano" (`ai_opt_out`),
 * silêncio do bot e conversa assumida por uma pessoa deixariam de valer para
 * esse cliente, justamente o mais novo da base.
 *
 * ─── Como a ordem é garantida ───────────────────────────────────────────────
 *
 * O degrau novo mora em `resolve-turn-agent`, que roda DEPOIS do portão em
 * todos os caminhos do turno (`inbound-turn.ts`: o `!elegib.permite` devolve
 * antes; o dreno, em `drain.ts`, nem enfileira). E ele não lê nem escreve nada
 * da elegibilidade: o módulo `lib/ai/elegibilidade` não conhece as colunas da
 * campanha de entrada. As duas coisas são medidas aqui — a primeira no texto,
 * porque é uma propriedade da ORDEM do arquivo, e a segunda no comportamento.
 */

const INBOUND = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");

function posicoes(texto: string, agulha: string): number[] {
  return [...texto.matchAll(new RegExp(agulha.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))].map(
    (m) => m.index ?? -1,
  );
}

const AGORA = new Date("2026-11-05T12:00:00Z");
const DIA = 24 * 60 * 60 * 1000;

/** O contato que chegou pela campanha: AUTORIZADO e dentro da janela. */
const autorizadoPelaCampanha: EstadoDeElegibilidade = {
  orgStatus: "active",
  canalDesativado: false,
  modo: "allowlist",
  forceHuman: false,
  contatoInterno: false,
  contatoDaEquipe: false,
  aiOptOut: false,
  botSilencedUntil: null,
  assigneeKind: "ai",
  // Campo novo da régua que a main ganhou ("a IA responde a conversa sem tirar o
  // dono de quem atende"): com `iaComDono: false` o dono humano continua vetando,
  // que é o comportamento que este teste já cobria em `assigneeKind: "user"`.
  iaComDono: false,
  aiAuthorizedAt: new Date(AGORA.getTime() - DIA),
  preGoLiveAtivo: false,
  numeroDeTesteAutorizado: false,
  agora: AGORA,
  ttlMs: 21 * DIA,
};

describe("a régua de elegibilidade continua mandando no cliente que veio da campanha", () => {
  it("controle positivo: autorizado pela campanha, sem veto nenhum, a IA atende", () => {
    const d = decidirElegibilidade(autorizadoPelaCampanha);
    expect(d.permite).toBe(true);
    expect(d.motivo).toBe("autorizado");
  });

  it.each([
    ["dono humano na conversa", { assigneeKind: "user" }, "conversa_de_humano"],
    ["force_human", { forceHuman: true }, "force_human"],
    ["'sempre atendimento humano'", { aiOptOut: true }, "ai_opt_out"],
    ["silêncio do bot", { botSilencedUntil: new Date(AGORA.getTime() + DIA) }, "conversa_silenciada"],
  ])("%s vence a autorização da campanha", (_nome, veto, motivo) => {
    const d = decidirElegibilidade({ ...autorizadoPelaCampanha, ...veto });
    expect(d.permite).toBe(false);
    expect(d.motivo).toBe(motivo);
  });
});

describe("o degrau da campanha de entrada não fura a ordem do turno", () => {
  it("o portão de elegibilidade roda ANTES de resolver quem atende — em todos os caminhos", () => {
    const portoes = posicoes(INBOUND, "decidirElegibilidadeDaConversa(");
    const resolucoes = posicoes(INBOUND, "resolveConversationTurn(");

    expect(portoes.length, "nenhum portão de elegibilidade em inbound-turn.ts").toBeGreaterThan(0);
    expect(resolucoes.length, "nenhuma resolução de agente em inbound-turn.ts").toBeGreaterThan(0);

    for (const resolucao of resolucoes) {
      expect(
        portoes.some((portao) => portao < resolucao),
        "há um caminho que resolve o agente ANTES de perguntar à régua se a IA pode falar",
      ).toBe(true);
    }
  });

  it("o turno devolve antes de resolver o agente quando a régua nega", () => {
    // O `!elegib.permite` + `return` é o que faz o degrau da campanha nem ser
    // consultado: sem ele, o portão existiria e não barraria nada.
    const negacao = INBOUND.indexOf("!elegib.permite");
    const resolucao = INBOUND.indexOf("resolveConversationTurn(");
    expect(negacao).toBeGreaterThan(-1);
    expect(negacao).toBeLessThan(resolucao);
  });

  it("a régua da elegibilidade NÃO lê a campanha de entrada — ela não decide agente", () => {
    // Se este teste ficar vermelho, alguém levou o `campaign_entry_agent_id`
    // para dentro da régua: aí o veto passaria a depender da campanha, que é o
    // oposto do desenho (a régua diz SE a IA fala; o degrau diz QUEM fala).
    // Comentário é prosa: o que se mede é CÓDIGO.
    for (const arquivo of ["gate.ts", "consulta-pg.ts", "consulta-supabase.ts", "campanha.ts"]) {
      const codigo = readFileSync(join(process.cwd(), "lib/ai/elegibilidade", arquivo), "utf8")
        .split("\n")
        .filter((linha) => !/^\s*(\/\/|\*|\/\*)/.test(linha))
        .join("\n");
      expect(codigo, `${arquivo} LÊ a campanha de entrada no código`).not.toContain(
        "campaign_entry_agent",
      );
    }
  });
});
