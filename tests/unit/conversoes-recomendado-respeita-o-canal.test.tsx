/**
 * A recomendação de evento por etapa leva o CANAL em conta — o #2890.
 *
 * ─── O que acontecia antes ─────────────────────────────────────────────────
 *
 * `eventoRecomendadoParaMeta` (`lib/conversoes/regras-meta.ts`) decidia SÓ
 * pelo nome da etapa e devolvia `QualifiedLead` para etapa com "qualific",
 * "interess" ou "diagnost" no nome — sem saber se a instalação tem conexão
 * direta da Meta. Só o canal da conversa repassa eventos de etapa, e a lista
 * dele (`EVENTOS_DE_ETAPA_NO_CANAL`) não tinha `QualifiedLead`: numa instalação
 * só-com-canal, o botão "Usar o recomendado" (`_regrasMeta.tsx`) ligava a etapa
 * com um evento sem saída, e o aviso do #2839 aparecia em seguida.
 *
 * O #2890 fez a sugestão perguntar se o evento tem saída. Desde 27/10/2026 o
 * canal repassa `QualifiedLead` — o provedor passou a aceitá-lo —, e a mesma
 * pergunta agora responde "sim": etapa de qualificação recebe `QualifiedLead`
 * também sem conexão direta, e a invariante "nenhuma sugestão sem saída" segue
 * valendo.
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
    ["Lead qualificado", "QualifiedLead"],
    ["Interessado", "QualifiedLead"],
    ["Diagnóstico", "QualifiedLead"],
    ["Cliente qualificado", "QualifiedLead"],
  ])(
    "⭐ sem conexão direta, etapa de nome %s sugere QualifiedLead — o canal o repassa",
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
    "com conexão direta, o comportamento é o de sempre: %s → %s",
    (nome, esperado) => {
      expect(eventoRecomendadoParaMeta(nome, true)).toBe(esperado);
    },
  );

  it("etapa sem nome reconhecível fica sem sugestão", () => {
    expect(eventoRecomendadoParaMeta("Novo", false)).toBeNull();
  });

  it("sem conexão direta, nenhuma sugestão está fora da lista do canal", () => {
    // Não vacuidade: a etapa de qualificação, que era o caso do defeito, agora
    // sugere algo — e é justamente ela que a invariante precisa vigiar.
    expect(eventoRecomendadoParaMeta("Qualificação", false)).toBe("QualifiedLead");
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
  it("⭐ sem conexão direta: liga a etapa de qualificação com QualifiedLead, e a de orçamento com InitiateCheckout", () => {
    abrir(false);

    // Não vacuidade: a tela das regras está montada, com os dois switches
    // desligados — sem isto, "ligou" valeria por outro motivo.
    expect(screen.getByTestId("regras-meta-por-etapa")).toBeInTheDocument();
    expect(switchDaEtapa(QUALIFICACAO.id)).not.toBeChecked();
    expect(switchDaEtapa(ORCAMENTO.id)).not.toBeChecked();

    usarRecomendado();

    expect(switchDaEtapa(QUALIFICACAO.id)).toBeChecked();
    expect(eventoDaEtapa(QUALIFICACAO.id)).toHaveValue("QualifiedLead");
    expect(
      screen.queryByTestId(`aviso-evento-fora-do-canal-${QUALIFICACAO.id}`),
      "a recomendação ligou a etapa e, no mesmo instante, avisou que ela não tem saída",
    ).toBeNull();
    expect(switchDaEtapa(ORCAMENTO.id)).toBeChecked();
    expect(eventoDaEtapa(ORCAMENTO.id)).toHaveValue("InitiateCheckout");
  });

  it("com conexão direta: o botão liga a etapa de qualificação com QualifiedLead, como sempre", () => {
    abrir(true);
    usarRecomendado();

    expect(switchDaEtapa(QUALIFICACAO.id)).toBeChecked();
    expect(eventoDaEtapa(QUALIFICACAO.id)).toHaveValue("QualifiedLead");
    expect(switchDaEtapa(ORCAMENTO.id)).toBeChecked();
    expect(eventoDaEtapa(ORCAMENTO.id)).toHaveValue("InitiateCheckout");
  });
});
