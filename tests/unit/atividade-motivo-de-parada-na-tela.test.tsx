import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ActivityTab } from "@/app/app/webhooks/_components/ActivityTab";
import type { AutomationRuleRunRow } from "@/hooks/webhooks/useAutomationRules";

/**
 * A PROVA DE TELA DA #1090 — o que quem opera a automação lê na aba Atividade.
 *
 * ─── O defeito, como ele chegava ao olho de quem dá suporte ─────────────────
 *
 * `membro_indeterminado` é o código que `assign_owner` devolve quando a consulta
 * de membro não responde (rede/banco) — ela não pode nem afirmar nem negar que
 * a pessoa atende. A ação grava a mensagem da consulta em `detail.erro` "para o
 * suporte" (palavras do cabeçalho da ação). Só que a aba Atividade imprimia
 * `explicacao ?? action.error`: o mapa de frases não tinha o código, `error` é o
 * próprio código, e a tela mostrava `membro_indeterminado` — sem a mensagem,
 * sem frase, sem próximo passo. Quem atende via um identificador de máquina no
 * lugar do motivo e, sem o texto do erro, não tinha o que levar ao time técnico.
 *
 * ─── As três propriedades cobradas aqui são de PRODUTO ─────────────────────
 *
 *   1. a linha da ação diz o MOTIVO em português, nunca o código;
 *   2. o detalhe técnico APARECE (decisão registrada em `detalheTecnicoDe`), e
 *      depois da frase — nunca no lugar dela;
 *   3. execução que deu certo não ganha linha técnica nenhuma.
 *
 * O tradutor é dublado por identidade de propósito: em português `t()` devolve
 * a própria chave, então o que este teste mede é QUAL das duas strings a tela
 * escolhe — a frase ou o código. Se a tradução fosse dublada "de mentira" (por
 * exemplo, devolvendo um texto fixo), a asserção de frase não provaria nada.
 * Quem cobra o espanhol é `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`.
 *
 * Roda com: npx vitest run tests/unit/atividade-motivo-de-parada-na-tela.test.tsx
 */

const estado = vi.hoisted(() => ({ runs: [] as unknown[] }));

vi.mock("@/hooks/webhooks/useAutomationRules", () => ({
  useAutomationRuns: () => ({
    data: { data: estado.runs },
    isLoading: false,
    refetch: vi.fn(),
    isRefetching: false,
  }),
  useResendAutomationRun: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({
  useLocaleDeData: () => undefined,
  useTagDeIdioma: () => "pt-BR",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

function corrida(
  actions: AutomationRuleRunRow["actions_result"],
  status: AutomationRuleRunRow["status"] = "failed",
): AutomationRuleRunRow {
  return {
    id: "run-1",
    organization_id: "org-1",
    rule_id: "rule-1",
    event_id: null,
    status,
    actions_result: actions,
    error: null,
    created_at: new Date().toISOString(),
    automation_rules: { name: "Regra da prova de tela" },
  };
}

function telaDaAba(run: AutomationRuleRunRow): string {
  estado.runs = [run];
  render(<ActivityTab />);
  return document.body.textContent ?? "";
}

/** Qualquer motivo em formato de código. Nenhum deles pode aparecer na tela. */
const CODIGO_CRU = /(membro_indeterminado|user_not_in_org|invalid_owner|missing_config|missing_input)/;

describe("aba Atividade: o motivo de parada chega em português, com o detalhe técnico", () => {
  it("a falha da consulta de membro diz o motivo, e não o código cru", () => {
    const tela = telaDaAba(
      corrida([
        {
          type: "assign_owner",
          status: "failed",
          error: "membro_indeterminado",
          detail: { reason: "membro_indeterminado", erro: "TypeError: fetch failed" },
        },
      ]),
    );

    // A frase: é ela que responde "por que a ação não aconteceu".
    expect(tela).toContain("Não deu para saber quem atende este contato");
    // E o identificador de máquina saiu da tela de quem atende.
    expect(tela).not.toMatch(CODIGO_CRU);
  });

  it("o detalhe do erro aparece ROTULADO e DEPOIS da frase", () => {
    const tela = telaDaAba(
      corrida([
        {
          type: "assign_owner",
          status: "failed",
          error: "membro_indeterminado",
          detail: { reason: "membro_indeterminado", erro: "TypeError: fetch failed" },
        },
      ]),
    );

    expect(tela).toContain("Detalhe técnico:");
    expect(tela).toContain("TypeError: fetch failed");
    // Ordem: quem lê recebe primeiro a frase, depois o texto técnico.
    expect(tela.indexOf("Não deu para saber quem atende")).toBeLessThan(
      tela.indexOf("Detalhe técnico:"),
    );
  });

  it("a falha que só traz `error` (sem detalhe nenhum) também ganha frase", () => {
    // `user_not_in_org` e `invalid_owner` são devolvidos SÓ em `error`: era o
    // segundo furo da issue, que o mapa não alcançava.
    const tela = telaDaAba(
      corrida([{ type: "assign_owner", status: "failed", error: "user_not_in_org" }]),
    );

    expect(tela).toContain("A pessoa escolhida como responsável não é atendente desta equipe");
    expect(tela).not.toMatch(CODIGO_CRU);
  });

  it("o motivo que pulou a ação também sai em português", () => {
    const tela = telaDaAba(
      corrida([{ type: "add_tag", status: "skipped", detail: { reason: "no_tags" } }], "partial"),
    );

    expect(tela).toContain("Esta ação não tem nenhuma etiqueta escolhida");
    expect(tela).not.toMatch(CODIGO_CRU);
  });

  it("a ação que deu certo não ganha linha técnica", () => {
    const tela = telaDaAba(
      corrida([{ type: "add_tag", status: "success", detail: { added: [] } }], "success"),
    );

    expect(tela).not.toContain("Detalhe técnico:");
  });

  it("motivo que a guarda não conhece ainda aparece (código é melhor que silêncio)", () => {
    // O contrário do silêncio: se um dia chegar um motivo sem frase, a tela
    // mostra o código — e a guarda de mapa reprova o PR que o criou. Este caso
    // trava a decisão para ninguém "consertar" o fallback apagando a informação.
    const tela = telaDaAba(
      corrida([{ type: "add_tag", status: "skipped", detail: { reason: "motivo_ainda_sem_frase" } }], "partial"),
    );

    expect(tela).toContain("motivo_ainda_sem_frase");
  });

  it("a vez do rodízio sai do molde traduzível, com nome e posição colados depois (#2041)", () => {
    // A frase pronta em `explicacao` muda a cada lead e nunca casaria com o
    // dicionário: quem lia em inglês via português. Sem `explicacao` aqui, só o
    // caminho do molde produz a frase.
    const tela = telaDaAba(
      corrida([{ type: "assign_owner", status: "success", detail: { user_id: "u-1", posicao: 2, nome: "Ana" } }], "success"),
    );

    expect(tela).toContain("Vez de Ana, posição 2 da fila do rodízio.");
  });
});
