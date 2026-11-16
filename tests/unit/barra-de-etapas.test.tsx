import { readFileSync } from "node:fs";

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { diasNaEtapa, montarBarraDeEtapas, type EtapaDaBarra } from "@/lib/kanban/barra-de-etapas";

/**
 * A BARRA DE ETAPAS NO TOPO DO NEGÓCIO.
 *
 * As etapas abertas do funil em sequência, a atual em destaque com "Nome (N
 * dias)", as anteriores como percorridas e as seguintes neutras. Ganho e perda
 * ficam de fora: são desfechos, com ações próprias.
 *
 * O clique NÃO move nada sozinho: chama `onMudar`, o MESMO fio do seletor
 * `EtapaNoDossie` — que `etapa-pelo-dossie.test.tsx` já prova chegar ao "Mover
 * para…" do quadro (topo da etapa, trava de `updated_at`, motivo da perda,
 * campos obrigatórios). Este arquivo mede a barra e a fiação no dossiê.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

import { BarraDeEtapas } from "@/components/kanban/BarraDeEtapas";

const ETAPAS: EtapaDaBarra[] = [
  { id: "e-1", name: "Etapa A", is_won: false, is_lost: false },
  { id: "e-2", name: "Etapa B", is_won: false, is_lost: false },
  { id: "e-3", name: "Etapa C", is_won: false, is_lost: false },
  { id: "e-4", name: "Etapa D", is_won: false, is_lost: false },
  { id: "e-ganho", name: "Ganhamos", is_won: true, is_lost: false },
  { id: "e-perda", name: "Perdemos", is_won: false, is_lost: true },
];

function montar(extra: Partial<Parameters<typeof BarraDeEtapas>[0]> = {}) {
  const onMudar = vi.fn();
  const utils = render(
    <BarraDeEtapas etapaAtual="e-2" etapas={ETAPAS} podeMover onMudar={onMudar} dias={3} {...extra} />,
  );
  return { onMudar, ...utils };
}

function passos(): HTMLElement[] {
  return within(screen.getByRole("navigation", { name: "Etapas do funil" })).getAllByRole("listitem");
}

describe("a barra de etapas — o desenho", () => {
  it("mostra só as etapas abertas, na ordem recebida: ganho e perda ficam fora", () => {
    montar();
    expect(passos().map((p) => p.textContent)).toEqual([
      "concluída: Etapa A",
      "Etapa B (3 dias)",
      "Etapa C",
      "Etapa D",
    ]);
    expect(screen.queryByText("Ganhamos")).not.toBeInTheDocument();
    expect(screen.queryByText("Perdemos")).not.toBeInTheDocument();
  });

  it("a etapa atual leva aria-current=\"step\" e o texto \"Nome (N dias)\"; só ela", () => {
    montar();
    const atuais = passos().filter((p) => p.getAttribute("aria-current") === "step");
    expect(atuais).toHaveLength(1);
    expect(atuais[0]!.textContent).toBe("Etapa B (3 dias)");
  });

  it("anteriores são marcadas como concluídas; seguintes, neutras", () => {
    montar({ etapaAtual: "e-3" });
    expect(passos().map((p) => p.getAttribute("data-estado"))).toEqual(["anterior", "anterior", "atual", "seguinte"]);
    // O "concluída" vai para o leitor de tela, não só para a cor.
    expect(passos()[0]!.textContent).toBe("concluída: Etapa A");
    expect(passos()[3]!.textContent).toBe("Etapa D");
  });

  it("diz em que posição o negócio está — \"Etapa N de M\" — contando só as abertas", () => {
    montar({ etapaAtual: "e-3" });
    expect(screen.getByTestId("barra-de-etapas-posicao").textContent).toBe("Etapa 3 de 4");
  });

  it("um dia é singular; sem data de entrada, só o nome", () => {
    const { rerender } = montar({ dias: 1 });
    expect(screen.getByText("Etapa B (1 dia)")).toBeInTheDocument();
    rerender(<BarraDeEtapas etapaAtual="e-2" etapas={ETAPAS} podeMover onMudar={vi.fn()} dias={null} />);
    const atual = passos().find((p) => p.getAttribute("aria-current") === "step")!;
    expect(atual.textContent).toBe("Etapa B");
  });

  it("negócio num desfecho (ganho ou perda) não desenha barra", () => {
    montar({ etapaAtual: "e-perda" });
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    montar({ etapaAtual: "e-ganho" });
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("funil vazio (ou só com desfechos) não desenha barra", () => {
    montar({ etapas: [] });
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    montar({ etapas: ETAPAS.filter((e) => e.is_won || e.is_lost), etapaAtual: "e-ganho" });
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
});

describe("a barra de etapas — o clique", () => {
  it("clicar numa etapa pede o movimento a quem chama, com o id da etapa", async () => {
    const { onMudar } = montar();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Etapa D" }));
    expect(onMudar).toHaveBeenCalledTimes(1);
    expect(onMudar).toHaveBeenCalledWith("e-4");
  });

  it("voltar para uma etapa anterior também passa por quem chama", async () => {
    const { onMudar } = montar();
    await userEvent.setup().click(screen.getByRole("button", { name: /Etapa A/ }));
    expect(onMudar).toHaveBeenCalledWith("e-1");
  });

  it("a etapa atual não é botão: não há o que mover", () => {
    montar();
    expect(screen.queryByRole("button", { name: /Etapa B/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("dá para chegar pelo teclado: Tab foca a etapa e Enter move", async () => {
    const { onMudar } = montar();
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("button", { name: /Etapa A/ })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Etapa C" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onMudar).toHaveBeenCalledWith("e-3");
  });

  it("sem permissão de mover, a barra só mostra: nenhum botão", async () => {
    const { onMudar } = montar({ podeMover: false });
    expect(screen.getByRole("navigation", { name: "Etapas do funil" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByText("Etapa D"));
    expect(onMudar).not.toHaveBeenCalled();
  });

  it("sem quem mova (sem onMudar), também só mostra", () => {
    montar({ onMudar: undefined });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("a regra pura", () => {
  it("montarBarraDeEtapas devolve a posição contando só as etapas abertas", () => {
    const barra = montarBarraDeEtapas(ETAPAS, "e-4");
    expect(barra).toMatchObject({ posicaoAtual: 4, total: 4 });
    expect(barra?.passos.map((p) => p.estado)).toEqual(["anterior", "anterior", "anterior", "atual"]);
  });

  it("etapa que não está na lista: sem barra", () => {
    expect(montarBarraDeEtapas(ETAPAS, "outra")).toBeNull();
  });

  const AGORA = new Date("2026-10-20T12:00:00.000Z");
  const HA = (dias: number, horas = 0) => new Date(AGORA.getTime() - (dias * 24 + horas) * 3_600_000).toISOString();

  it("dias na etapa contam pela ENTRADA na etapa (stage_changed_at), em dias inteiros", () => {
    expect(diasNaEtapa({ stage_changed_at: HA(5, 23), created_at: HA(40) }, AGORA)).toBe(5);
    expect(diasNaEtapa({ stage_changed_at: HA(0, 3), created_at: HA(40) }, AGORA)).toBe(0);
  });

  it("sem carimbo de entrada, a reserva é a criação do negócio", () => {
    expect(diasNaEtapa({ stage_changed_at: null, created_at: HA(2) }, AGORA)).toBe(2);
  });

  it("sem data nenhuma (ou data inválida), null; relógio adiantado não vira negativo", () => {
    expect(diasNaEtapa({ stage_changed_at: null, created_at: null }, AGORA)).toBeNull();
    expect(diasNaEtapa({ stage_changed_at: "não é data" }, AGORA)).toBeNull();
    expect(diasNaEtapa({ stage_changed_at: new Date(AGORA.getTime() + 3_600_000).toISOString() }, AGORA)).toBe(0);
  });
});

describe("o dossiê monta a barra com o mesmo fio do seletor", () => {
  // Complemento: o comportamento do fio está em `LeadDossier.test.tsx` (com o
  // dossiê de verdade) e em `etapa-pelo-dossie.test.tsx` (o quadro).
  const dossie = readFileSync("components/kanban/LeadDossier.tsx", "utf8");

  it("passa onMudarEtapa e a permissão de mover card à barra, e mantém o seletor", () => {
    expect(dossie).toMatch(/<BarraDeEtapas[\s\S]*?podeMover=\{podeMoverCard\}[\s\S]*?onMudar=\{onMudarEtapa\}/);
    expect(dossie).toMatch(/<EtapaNoDossie[\s\S]*?onMudar=\{onMudarEtapa\}/);
  });
});
