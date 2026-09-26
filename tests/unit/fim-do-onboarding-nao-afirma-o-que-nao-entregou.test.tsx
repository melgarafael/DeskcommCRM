/**
 * O FIM DO WIZARD NÃO AFIRMA O QUE NÃO ENTREGOU.
 *
 * MEDIDO na tela (issue #1694, item 4): a última página dizia "Tudo pronto!
 * Seu funcionário já está de pé" para quem pulou o passo da IA e para quem
 * ficou com o atendente em rascunho — a promessa feita antes da pessoa
 * descobrir, no primeiro cliente, que ninguém estava respondendo.
 *
 * O que decide é `noAr` (a página lê `ai_agents.published_version_id` no
 * banco), não a contagem de pendências: publicar é o que coloca o atendente
 * no ar. Pular telefone/equipe sem pular a IA não tira ninguém do ar, e é
 * justamente o caso em que a frase antiga continuava certa.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DoneClient } from "@/app/onboarding/done/_client";
import type { ItemDoResumo } from "@/lib/onboarding/passos";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/app/actions/onboarding/finishOnboarding", () => ({
  finishOnboarding: vi.fn(async () => ({ ok: true })),
}));

function item(segmento: string, campo: { feito?: boolean; pulado?: boolean } = {}): ItemDoResumo {
  const { feito = true, pulado = false } = campo;
  return { segmento, rotulo: segmento, feito, pulado };
}

/** Todos os passos cumpridos — inclusive a IA. */
function todosCumpridos(): ItemDoResumo[] {
  return [
    item("welcome"),
    item("connect-whatsapp"),
    item("setup-ai"),
    item("funil"),
    item("testar"),
    item("invite-team"),
  ];
}

function tela(itens: ItemDoResumo[], noAr: boolean): string {
  render(<DoneClient itens={itens} pecas={[]} noAr={noAr} />);
  return document.body.textContent ?? "";
}

describe("a última página do wizard concorda com o banco", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pulou a IA e o agente não foi publicado: não diz que está de pé", () => {
    const itens = todosCumpridos().map((i) =>
      i.segmento === "setup-ai" ? item("setup-ai", { feito: false, pulado: true }) : i,
    );

    const texto = tela(itens, false);

    expect(texto, "a tela prometeu o que a pessoa pulou").not.toContain("já está de pé");
    expect(texto).toContain("Quase lá!");
    expect(texto).toContain(
      "O passo da IA ficou para depois: ele ainda não foi treinado nem colocado no ar.",
    );
  });

  it("treinado mas em rascunho: diz que o atendimento não foi publicado", () => {
    const texto = tela(todosCumpridos(), false);

    expect(texto).not.toContain("já está de pé");
    expect(texto).toContain("Quase lá!");
    expect(texto).toContain(
      "Ele já foi treinado, mas o atendimento ainda não foi publicado — ele segue em rascunho.",
    );
  });

  it("no ar e sem pendências: é a frase de sempre", () => {
    const texto = tela(todosCumpridos(), true);

    expect(texto).toContain("Tudo pronto!");
    expect(texto).toContain("Seu funcionário está montado. Daqui em diante é só acompanhar.");
  });

  it("no ar com passo pulado que NÃO é a IA: segue de pé, porque está mesmo", () => {
    const itens = todosCumpridos().map((i) =>
      i.segmento === "connect-whatsapp" ? item("connect-whatsapp", { feito: false, pulado: true }) : i,
    );

    const texto = tela(itens, true);

    expect(texto).toContain("Tudo pronto!");
    expect(texto).toContain(
      "Seu funcionário já está de pé. O que ficou para depois continua te esperando.",
    );
  });
});
