/**
 * A DURAÇÃO NA TELA DE MARCAR (issue #3709).
 *
 * ─── O que só a MONTAGEM prova ────────────────────────────────────────────
 *
 * O motor foi medido em `lib/agenda/duracao-escolhida.test.ts`: ele respeita a
 * duração que recebe. Falta a outra metade, que é onde a issue pede a mudança:
 * a tela precisa OFERECER a duração, abrir com o valor do serviço e ser o que
 * impede um valor fora de 5…1440 de chegar ao banco.
 *
 * Os três casos, em uma frase cada:
 *
 *   1. o campo nasce com a duração do serviço — o padrão não foi removido;
 *   2. mudar a duração AVISA quem calcula os horários e LIMPA o horário já
 *      escolhido, porque aquela lista era da régua anterior;
 *   3. valor fora da faixa não é anunciado, mostra o motivo e trava o
 *      Confirmar — a recusa acontece antes da rede, não depois do 422.
 *
 * A largura e a beleza não estão em causa aqui; o que se mede é comportamento.
 *
 *     npx vitest run tests/unit/agenda-duracao-escolhida.test.tsx
 */
import { readFileSync } from "node:fs";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PainelDeMarcacao } from "@/components/agenda/PainelDeMarcacao";
import type { HorarioLivre, Pessoa } from "@/components/agenda/tipos";

afterEach(cleanup);

const AGORA = new Date("2026-09-15T12:00:00");
const RESPONSAVEL: Pessoa = { id: "p1", nome: "Ana", trilha: 1 };

/** Quarta, 16/09: dois horários publicados. O que eles exigem vem da rota. */
const HORARIOS: Record<string, HorarioLivre[]> = {
  "2026-09-16": [
    { instante: "2026-09-16T13:00:00.000Z", rotulo: "10:00" },
    { instante: "2026-09-16T14:00:00.000Z", rotulo: "11:00" },
  ],
};

type Props = Partial<ComponentProps<typeof PainelDeMarcacao>>;

function montar(sobre: Props = {}) {
  const onConfirmar = vi.fn(async () => undefined);
  const onDuracaoMudar = vi.fn();
  render(
    <PainelDeMarcacao
      ancora={AGORA}
      agora={AGORA}
      responsavel={RESPONSAVEL}
      fuso="America/Sao_Paulo"
      horariosPorDia={HORARIOS}
      duracaoMin={30}
      {...sobre}
      onConfirmar={onConfirmar}
      onDuracaoMudar={onDuracaoMudar}
    />,
  );
  return { onConfirmar, onDuracaoMudar };
}

function campoDaDuracao(): HTMLInputElement {
  return screen.getByTestId("duracao-do-atendimento") as HTMLInputElement;
}

describe("a duração do serviço é o PADRÃO da marcação, não a única opção", () => {
  it("o campo abre com a duração do serviço já preenchida", () => {
    montar({ duracaoMin: 30 });
    expect(campoDaDuracao().value).toBe("30");
    // O resumo em texto continua dizendo o que é: nada de número solto.
    expect(screen.getByText("Duração (minutos)")).toBeInTheDocument();
  });

  it("o padrão é o do SERVIÇO: um tipo de 45 minutos abre com 45", () => {
    montar({ duracaoMin: 45 });
    expect(campoDaDuracao().value).toBe("45");
  });

  it("o serviço de agenda própria (sem escolha) mostra a duração, e não um campo", () => {
    // Serviço e remarcação não escolhem duração: a rota recusa num caso e o
    // PATCH preserva o comprimento no outro. Oferecer o campo ali seria
    // oferecer um caminho que não existe.
    montar({ duracaoMin: 60, permiteEscolherDuracao: false });
    expect(screen.queryByTestId("duracao-do-atendimento")).not.toBeInTheDocument();
    expect(screen.getByText("60 minutos")).toBeInTheDocument();
  });
});

describe("mudar a duração avisa quem calcula os horários", () => {
  it("anuncia o valor novo — a lista é do servidor, e ela precisa saber", () => {
    const { onDuracaoMudar } = montar({ duracaoMin: 30 });
    fireEvent.change(campoDaDuracao(), { target: { value: "90" } });
    expect(onDuracaoMudar).toHaveBeenLastCalledWith(90);
  });

  it("troca a duração LIMPA o horário já escolhido, e a lista volta a mandar", () => {
    // Sem isto, a pessoa confirmaria 10:00 de uma lista de 30 minutos com 90
    // marcados no campo — o jeito silencioso de marcar em cima do próximo
    // paciente.
    montar({ duracaoMin: 30 });
    fireEvent.click(screen.getByTestId("dia-2026-09-16"));
    fireEvent.click(screen.getByTestId("horario-10:00"));
    expect(screen.getByTestId("confirmacao")).toBeInTheDocument();

    fireEvent.change(campoDaDuracao(), { target: { value: "90" } });
    expect(screen.queryByTestId("confirmacao")).not.toBeInTheDocument();
    expect(screen.getByTestId("painel-de-marcacao")).toHaveAttribute("data-tempo", "escolhendo-horario");
  });

  it("a confirmação leva a duração escolhida junto", async () => {
    const { onConfirmar } = montar({ duracaoMin: 30 });
    fireEvent.change(campoDaDuracao(), { target: { value: "90" } });
    fireEvent.click(screen.getByTestId("dia-2026-09-16"));
    fireEvent.click(screen.getByTestId("horario-10:00"));
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));

    // A confirmação espera o servidor (é o conserto do #1540): o argumento é
    // lido quando a promessa resolve.
    await waitFor(() =>
      expect(onConfirmar).toHaveBeenCalledWith("2026-09-16T13:00:00.000Z", 90),
    );
  });
});

describe("valor fora de 5…1440 é barrado AQUI, não no banco", () => {
  it("3 minutos: mostra o motivo, não anuncia e trava o Confirmar", () => {
    const { onDuracaoMudar } = montar({ duracaoMin: 30 });
    onDuracaoMudar.mockClear();
    fireEvent.change(campoDaDuracao(), { target: { value: "3" } });

    expect(screen.getByTestId("duracao-invalida")).toHaveTextContent(
      "Escolha uma duração entre 5 e 1440 minutos.",
    );
    // Nada é anunciado: a lista em tela continua sendo a da última régua válida,
    // então o servidor não recebe uma consulta inútil.
    expect(onDuracaoMudar).not.toHaveBeenCalled();
  });

  it("acima do teto também é recusado", () => {
    montar({ duracaoMin: 30 });
    fireEvent.change(campoDaDuracao(), { target: { value: "1441" } });
    expect(screen.getByTestId("duracao-invalida")).toBeInTheDocument();
  });

  it("com a duração inválida o Confirmar fica travado — e não sai requisição", () => {
    const { onConfirmar } = montar({ duracaoMin: 30 });
    fireEvent.click(screen.getByTestId("dia-2026-09-16"));
    fireEvent.click(screen.getByTestId("horario-10:00"));
    fireEvent.change(campoDaDuracao(), { target: { value: "2" } });

    // A troca já limpou a escolha (não há mais o que confirmar) e o botão, se
    // reaparecer por qualquer caminho, nasce desabilitado.
    expect(screen.queryByTestId("confirmar-marcacao")).not.toBeInTheDocument();
    expect(onConfirmar).not.toHaveBeenCalled();
  });

  it("vazio também é inválido: 0 não é uma duração", () => {
    montar({ duracaoMin: 30 });
    fireEvent.change(campoDaDuracao(), { target: { value: "" } });
    expect(screen.getByTestId("duracao-invalida")).toBeInTheDocument();
  });

  it("voltar para um valor válido tira o aviso e volta a anunciar", () => {
    const { onDuracaoMudar } = montar({ duracaoMin: 30 });
    fireEvent.change(campoDaDuracao(), { target: { value: "3" } });
    fireEvent.change(campoDaDuracao(), { target: { value: "45" } });
    expect(screen.queryByTestId("duracao-invalida")).not.toBeInTheDocument();
    expect(onDuracaoMudar).toHaveBeenLastCalledWith(45);
  });
});

/**
 * SERVIÇO NÃO ESCOLHE DURAÇÃO — e a tela não pode mandar uma.
 *
 * A rota recusa QUALQUER `duration_minutes` num tipo com `service_enabled`
 * (`agenda_duracao_do_servico`), porque ali o comprimento é o da agenda
 * publicada. O painel, por sua vez, SEMPRE devolve um número em `onConfirmar`.
 * Se a tela repassasse esse número, toda marcação de serviço pela /app/agenda
 * voltaria 422 — individual ou coletivo.
 *
 * A página não monta em teste (providers, hooks, rede), então a cerca lê o
 * arquivo, como `agenda-local-e-observacao-na-marcacao.test.ts` faz.
 */
describe("num serviço a tela não oferece nem envia duração", () => {
  const tela = readFileSync("app/app/agenda/_client.tsx", "utf8");
  const pagina = readFileSync("app/app/agenda/page.tsx", "utf8");

  it("a página marca TODO serviço, não só o coletivo", () => {
    expect(pagina).toContain("servico: t.service_enabled,");
  });

  it("o campo some em qualquer serviço — inclusive o individual por profissional", () => {
    expect(tela).toContain("permiteEscolherDuracao={!remarcandoId && !tipo.servico}");
  });

  it("o POST de um serviço não leva duration_minutes", () => {
    const inicio = tela.indexOf("return marcar");
    const bloco = tela.slice(inicio, tela.indexOf(".then((r) => {", inicio));
    expect(bloco).toContain("duration_minutes: tipo.servico ? undefined : duracaoDoAtendimento");
  });

  it("a consulta de horários de um serviço não manda duracao_minutos", () => {
    expect(tela).toMatch(/duracao_minutos: tipo\.servico\s*\?\s*undefined/);
  });
});
