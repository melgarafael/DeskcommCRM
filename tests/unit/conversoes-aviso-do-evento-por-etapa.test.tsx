/**
 * O AVISO NO SELETOR DE EVENTO DA ETAPA — o que o #2457 pede.
 *
 * ─── O que acontecia antes ─────────────────────────────────────────────────
 *
 * `EVENTOS_DA_META` (a lista do seletor) era MAIOR que `EVENTOS_DE_ETAPA_NO_CANAL`
 * (o que o canal da conversa repassa): `QualifiedLead` e `ViewContent` estavam
 * na primeira e fora da segunda — e o `QualifiedLead` é sugestão da própria tela
 * para etapa de nome "qualificado". Numa instalação só-com-canal, sem conexão
 * direta, quem escolhia um desses salvava a regra e o evento ficava na pendência
 * `evento_fora_do_canal`: o aviso existia, nomeado, mas chegava DIAS depois, no
 * Histórico, que é onde ninguém procura a causa de um evento que não saiu.
 *
 * A tela passou a avisar no ATO da escolha, com a lista que o envio aceita.
 *
 * ─── E depois (27/10/2026) ─────────────────────────────────────────────────
 *
 * O provedor do canal passou a aceitar `QualifiedLead` e `ViewContent`, e os
 * dois entraram na lista do canal. Hoje toda opção do seletor sai pelo canal —
 * escolher "Lead qualificado" sem conexão direta não avisa mais nada. O aviso
 * continua desenhado para o nome que o canal não conhece, e é por isso que o
 * último caso de tela abaixo monta a regra com um nome fora da lista.
 *
 * ─── Por que o teste é de TELA, e não só da função ─────────────────────────
 *
 * A decisão é uma função pura (`eventoDaEtapaTemSaida`), fácil de provar sozinha.
 * O que uma função pura não pega — e este arquivo pega — é o aviso que existe no
 * módulo e NÃO é desenhado: condição trocada, prop que não chega, bloco que some.
 * Todo caso abaixo lê a tela renderizada, e não o módulo.
 *
 * Roda com: pnpm test:unit tests/unit/conversoes-aviso-do-evento-por-etapa.test.tsx
 */
import { render, screen } from "@testing-library/react";
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
  EVENTOS_DA_META,
  EVENTOS_DE_ETAPA_NO_CANAL,
  eventoDaEtapaTemSaida,
  rotuloDoEventoDaMeta,
  type EventoDaMeta,
  type RegraDeConversaoMeta,
} from "@/lib/conversoes/regras-meta";

const ETAPA: EtapaAberta = {
  id: "et1",
  nome: "Orçamento enviado",
  funil: "Comercial",
  primeira: false,
};

/**
 * Um nome que o canal NÃO conhece. Nenhuma opção do seletor é assim desde
 * 27/10/2026; a regra chega à tela com ele quando uma versão futura da tela o
 * gravou — o caso que a guarda do #2457 ainda precisa pegar.
 */
const FORA_DO_CANAL = "OrderCreated" as EventoDaMeta;
/** O evento que o canal repassa — o caso que NÃO pode avisar. */
const NO_CANAL: EventoDaMeta = "InitiateCheckout";

const ID_DO_AVISO = `aviso-evento-fora-do-canal-${ETAPA.id}`;

const regra = (metaEvent: EventoDaMeta, enabled = true): RegraDeConversaoMeta => ({
  id: "r1",
  stageId: ETAPA.id,
  eventName: `MetaEtapa:${ETAPA.id}`,
  metaEvent,
  enabled,
  configuredAt: "2026-01-01T00:00:00Z",
});

function abrir(metaEvent: EventoDaMeta, conexaoDireta: boolean, enabled = true) {
  return render(
    <RegrasDeConversaoMeta
      etapas={[ETAPA]}
      regras={[regra(metaEvent, enabled)]}
      idioma="pt-BR"
      conexaoDireta={conexaoDireta}
    />,
  );
}

const aviso = () => screen.queryByTestId(ID_DO_AVISO);

describe("Lead qualificado e Viu o conteúdo saem pelo canal (27/10/2026)", () => {
  it.each(["QualifiedLead", "ViewContent"] as const)(
    "⭐ %s sem conexão direta: escolhido na tela, e nenhum aviso de que não sai",
    (evento) => {
      abrir(evento, false);
      // Não vacuidade: a regra ligada está na tela com o evento escolhido.
      expect(screen.getByLabelText("Evento enviado à Meta")).toHaveValue(evento);
      expect(aviso(), `avisou que ${evento} não sai pelo canal, e ele sai`).toBeNull();
    },
  );
});

describe("o aviso do evento que não sai pelo canal (#2457)", () => {
  it("fora do vocabulário e sem conexão direta: avisa NO ATO, com a lista do envio", () => {
    abrir(FORA_DO_CANAL, false);

    // Não vacuidade: é a tela das regras de etapa que está montada, com a regra
    // ligada — sem isto, o aviso poderia estar ausente por o componente não ter
    // renderizado nada.
    expect(screen.getByTestId("regras-meta-por-etapa")).toBeInTheDocument();
    expect(screen.getByLabelText("Evento enviado à Meta")).toBeInTheDocument();

    const caixa = aviso();
    expect(caixa, "o aviso do evento fora do canal não foi desenhado").not.toBeNull();
    expect(caixa).toHaveAttribute("role", "alert");

    const texto = caixa?.textContent ?? "";
    // A frase: o evento não sai pelo canal, escolha um destes, ou configure a
    // conexão direta.
    expect(texto).toContain("não sai pelo canal da conversa");
    expect(texto).toContain("escolha um destes");
    expect(texto).toContain("conexão direta da Meta");
    // E a lista é a MESMA que o envio aceita, pelo rótulo que a tela mostra.
    for (const evento of EVENTOS_DE_ETAPA_NO_CANAL) {
      expect(texto).toContain(rotuloDoEventoDaMeta(evento));
    }
    // A compra não é opção de etapa: oferecê-la seria uma saída que não existe.
    expect(texto).not.toContain("Purchase");
  });

  it("o mesmo evento COM conexão direta configurada não avisa — o envio tem para onde sair", () => {
    abrir(FORA_DO_CANAL, true);
    expect(aviso(), "avisou de um evento que a conexão direta atende").toBeNull();
  });

  it("evento do vocabulário do canal não avisa", () => {
    abrir(NO_CANAL, false);
    expect(aviso(), "avisou de um evento que o canal repassa").toBeNull();
  });

  it("regra desligada não avisa — desligada, nada é enviado", () => {
    abrir(FORA_DO_CANAL, false, false);
    expect(aviso()).toBeNull();
  });
});

describe("a decisão é a mesma lista que o envio usa", () => {
  it("⭐ toda opção do seletor sai pelo canal, também sem conexão direta", () => {
    for (const { valor } of EVENTOS_DA_META) {
      expect(eventoDaEtapaTemSaida(valor, false), `o canal repassa ${valor}`).toBe(true);
    }
  });

  it("o nome que o canal não conhece não tem saída sem conexão direta, e tem com ela", () => {
    expect(eventoDaEtapaTemSaida(FORA_DO_CANAL, false)).toBe(false);
    expect(eventoDaEtapaTemSaida(FORA_DO_CANAL, true)).toBe(true);
  });
});
