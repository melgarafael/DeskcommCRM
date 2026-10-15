/**
 * A recomendação de evento por etapa leva o CANAL em conta — o #2890.
 *
 * ─── O que acontecia antes ─────────────────────────────────────────────────
 *
 * `eventoRecomendadoParaMeta` (`lib/conversoes/regras-meta.ts`) decidia SÓ
 * pelo nome da etapa e devolvia `QualifiedLead` para etapa com "qualific",
 * "interess" ou "diagnost" no nome — sem saber se a instalação tem conexão
 * direta da Meta. Só o canal da conversa repassa eventos de etapa, e a
 * lista dele é `EVENTOS_DE_ETAPA_NO_CANAL` (sem `QualifiedLead`): numa
 * instalação só-com-canal, o botão "Usar o recomendado" (`_regrasMeta.tsx`)
 * ligava a etapa com um evento sem saída, e o aviso do #2839 aparecia em
 * seguida — a tela recomendava e avisava que a recomendação não tem saída,
 * no mesmo instante.
 *
 * A sugestão agora recebe o estado da conexão direta: sem ela, etapa de
 * qualificação não tem evento do canal que a represente e fica sem sugestão;
 * com ela, o comportamento é o de sempre.
 *
 * ─── Por que este arquivo existe ────────────────────────────────────────────
 *
 * O teste da função pura sozinho não pega o botão que liga a etapa; o
 * teste da tela sozinho não nomeia a decisão. Aqui os dois se encontram: a
 * decisão, e o que o botão faz com ela.
 *
 * Roda com: pnpm test:unit tests/unit/conversoes-recomendado-respeita-o-canal.test.tsx
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), message: vi.fn() }),
}));
vi.mock("@/app/actions/settings/salvarRegrasDeConversaoMeta", () => ({
  salvarRegrasDeConversaoMeta: vi.fn(),
}));

import { RegrasDeConversaoMeta } from "@/app/app/settings/conversoes/_regrasMeta";
import type { EtapaAberta } from "@/app/app/settings/conversoes/_regrasGoogle";
import {
  EVENTOS_DE_ETAPA_NO_CANAL,
  eventoRecomendadoParaMeta,
} from "@/lib/conversoes/regras-meta";

const QUALIFICACAO: EtapaAberta = {
  id: "et-qualificacao",
  nome: "Qualificação",
  funil: "Comercial",
  primeira: false,
};
const ORCAMENTO: EtapaAberta = {
  id: "et-orcamento",
  nome: "Orçamento enviado",
  funil: "Comercial",
  primeira: false,
};

function abrir(conexaoDireta: boolean) {
  return render(
    <RegrasDeConversaoMeta
      etapas={[QUALIFICACAO, ORCAMENTO]}
      regras={[]}
      idioma="pt-BR"
      conexaoDireta={conexaoDireta}
    />,
  );
}

const switchDaEtapa = (id: string) =>
  within(screen.getByTestId(`regra-meta-${id}`)).getByRole("switch");

const eventoDaEtapa = (id: string) =>
  within(screen.getByTestId(`regra-meta-${id}`)).getByLabelText("Evento enviado à Meta");

const usarRecomendado = () =>
  fireEvent.click(screen.getByRole("button", { name: "Usar o recomendado" }));

describe("a sugestão não recomenda evento sem saída (#2890)", () => {
  it.each([
    ["Lead qualificado", null],
    ["Interessado", null],
    ["Diagnóstico", null],
    ["Cliente qualificado", null],
  ])(
    "sem conexão direta, etapa de nome %s não sugere QualifiedLead — não sugere nada",
    (nome, esperado) => {
      expect(eventoRecomendadoParaMeta(nome, false)).toBe(esperado);
    },
  );

  it.each([
    ["ORÇAMENTO ENVIADO", "InitiateCheckout"],
    ["Proposta", "InitiateCheckout"],
    ["VISITA AGENDADA", "LeadSubmitted"],
  ])(
    "sem conexão direta, etapa de nome %s continua sugerindo o evento do canal",
    (nome, esperado) => {
      expect(eventoRecomendadoParaMeta(nome, false)).toBe(esperado);
    },
  );

  it.each([
    ["Lead qualificado", "QualifiedLead"],
    ["ORÇAMENTO ENVIADO", "InitiateCheckout"],
    ["VISITA AGENDADA", "LeadSubmitted"],
  ])(
    "com conexão direta, o comportamento é o de hoje: %s → %s",
    (nome, esperado) => {
      expect(eventoRecomendadoParaMeta(nome, true)).toBe(esperado);
    },
  );

  it("sem conexão direta, nenhuma sugestão está fora da lista do canal", () => {
    // Não vacuidade: existe etapa sem sugestão (a de qualificação) — ela é o
    // caso do defeito; se toda etapa sugerisse algo, a invariante passaria
    // sem vigiar o que interessa.
    expect(eventoRecomendadoParaMeta("Qualificação", false)).toBeNull();
    for (const nome of [
      "Qualificação",
      "Lead qualificado",
      "Interessado",
      "Diagnóstico",
      "Orçamento enviado",
      "Proposta",
      "Visita agendada",
    ]) {
      const sugestao = eventoRecomendadoParaMeta(nome, false);
      if (sugestao === null) continue;
      expect(
        (EVENTOS_DE_ETAPA_NO_CANAL as readonly string[]).includes(sugestao),
        `sem conexão direta, ${nome} sugeriria ${sugestao}, que o canal não repassa`,
      ).toBe(true);
    }
  });
});

describe("o botão \"Usar o recomendado\" respeita o canal (#2890)", () => {
  it("sem conexão direta: não liga a etapa de qualificação, e liga a de orçamento com o evento do canal", () => {
    abrir(false);

    // Não vacuidade: a tela das regras está montada, com os dois switches
    // desligados — sem isto, "não ligou" valeria por a tela não ter rendido.
    expect(screen.getByTestId("regras-meta-por-etapa")).toBeInTheDocument();
    expect(switchDaEtapa(QUALIFICACAO.id)).not.toBeChecked();
    expect(switchDaEtapa(ORCAMENTO.id)).not.toBeChecked();

    usarRecomendado();

    // A etapa de qualificação fica sem evento para sugerir: o botão NÃO a
    // liga. Ligar com QualifiedLead era o defeito — a regra ficava gravada
    // com um evento que não sai pelo canal.
    expect(
      switchDaEtapa(QUALIFICACAO.id),
      "o botão ligou a etapa de qualificação com um evento fora do canal",
    ).not.toBeChecked();
    expect(
      within(screen.getByTestId(`regra-meta-${QUALIFICACAO.id}`)).queryByLabelText(
        "Evento enviado à Meta",
      ),
      "a etapa de qualificação ganhou seletor de evento ligado",
    ).toBeNull();

    // A etapa de orçamento sugere InitiateCheckout, que o canal repassa: o
    // botão continua funcionando para ela.
    expect(switchDaEtapa(ORCAMENTO.id)).toBeChecked();
    expect(eventoDaEtapa(ORCAMENTO.id)).toHaveValue("InitiateCheckout");
  });

  it("com conexão direta: o botão liga a etapa de qualificação com QualifiedLead, como hoje", () => {
    abrir(true);
    usarRecomendado();

    expect(switchDaEtapa(QUALIFICACAO.id)).toBeChecked();
    expect(eventoDaEtapa(QUALIFICACAO.id)).toHaveValue("QualifiedLead");
    expect(switchDaEtapa(ORCAMENTO.id)).toBeChecked();
    expect(eventoDaEtapa(ORCAMENTO.id)).toHaveValue("InitiateCheckout");
  });
});
