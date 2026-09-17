/**
 * O SIM DA PESSOA — a aba "Aguardando confirmação" precisa ter como dizer sim.
 *
 * ─── O defeito que esta cerca fecha ──────────────────────────────────────
 *
 * `pending` é PRÉ-RESERVA: a IA marcou, o horário já saiu dos livres, e o
 * compromisso só existe de verdade quando alguém aprova. A transição
 * `pending → confirmed` tinha rota (`PATCH` aceita `status: "confirmed"`),
 * regra (`lib/agenda/laco.ts`) e escritor — `crm_confirm_appointment`, a IA.
 * A TELA não tinha. Medido antes de escrever:
 *
 *     grep -n "Confirmar" components/agenda/HistoricoDaAgenda.tsx   # zero
 *
 * Consequência num negócio com `requires_confirmation` ligado (o caso de quem
 * escolheu "uma pessoa aprova cada horário"): o pedido chega na aba certa, quem
 * atende olha e não tem clique. Ou o cliente responde no WhatsApp e a IA
 * confirma, ou o prazo vence e `agenda-expira-pendentes` CANCELA — soltando um
 * horário que estava combinado. Quem aprova é todo mundo menos quem deveria.
 *
 * É o mesmo "campo sem escritor" da Decisão 17 (`onRealizado`/`onFaltou`), na
 * transição de cima, e a lição é a mesma: a varredura que consertaria os quatro
 * botões de uma vez custaria um `grep`.
 *
 * ─── Por que a aba importa tanto quanto o botão ──────────────────────────
 *
 * Confirmar o que já está confirmado é ruído; confirmar um CANCELADO ressuscita
 * um horário que a pessoa desmarcou. Por isso há caso para a aba que oferece E
 * casos para as que não podem oferecer — um botão presente na aba errada passa
 * em qualquer teste que só procure o botão.
 *
 * ─── O relógio é INJETADO ────────────────────────────────────────────────
 *
 * `agora` é prop e todo instante deriva de `AGORA`. Nada de `new Date()`.
 */
import { readFileSync } from "node:fs";

import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HistoricoDaAgenda, type AbaDoHistorico } from "@/components/agenda/HistoricoDaAgenda";
import { PESSOAS } from "@/components/agenda/dados-de-mentira";

import type { Agendamento, SituacaoDoAgendamento } from "@/components/agenda/tipos";

afterEach(cleanup);

/** Quarta-feira, 14h37 — o mesmo instante fixo do teste irmão da repartição. */
const AGORA = new Date("2026-08-26T14:37:00.000Z");

function instante(minutos: number): string {
  return new Date(AGORA.getTime() + minutos * 60_000).toISOString();
}

function ag(id: string, situacao: SituacaoDoAgendamento, comecaEmMinutos = 120): Agendamento {
  return {
    id,
    titulo: "Consulta",
    quemSeraAtendido: `Paciente ${id}`,
    responsavelId: "ana",
    comeca: instante(comecaEmMinutos),
    termina: instante(comecaEmMinutos + 30),
    tipo: "Consulta",
    origem: "mcp",
    situacao,
  };
}

function montar(agendamentos: Agendamento[], onConfirmar?: (id: string) => void) {
  return render(
    <HistoricoDaAgenda
      agendamentos={agendamentos}
      pessoas={PESSOAS}
      agora={AGORA}
      {...(onConfirmar ? { onConfirmar } : {})}
    />,
  );
}

/** Abre a aba antes de procurar: só a ativa desenha lista. */
function abrir(aba: AbaDoHistorico) {
  fireEvent.click(screen.getByTestId(`aba-${aba}`));
}

describe("confirmar um pedido de horário pela tela", () => {
  it("a aba Aguardando oferece Confirmar, e o clique entrega o id daquela linha", () => {
    const confirmou = vi.fn();
    montar([ag("pedido", "pending")], confirmou);

    abrir("aguardando");
    const botao = screen.getByTestId("confirmar-pedido");
    expect(
      botao,
      "botão cinza é o mesmo que botão ausente para quem precisa aprovar",
    ).not.toBeDisabled();

    fireEvent.click(botao);
    expect(confirmou).toHaveBeenCalledWith("pedido");
    expect(confirmou, "um clique, uma confirmação").toHaveBeenCalledTimes(1);
  });

  it("sem escritor ligado, o botão nasce DESABILITADO em vez de mentir", () => {
    // O molde de `onRealizado`/`onFaltou`: a tela que não recebeu o handler não
    // pode aceitar o clique e não fazer nada.
    montar([ag("pedido", "pending")]);
    abrir("aguardando");
    expect(screen.getByTestId("confirmar-pedido")).toBeDisabled();
  });

  it("as outras abas NÃO oferecem Confirmar", () => {
    // Confirmar o já confirmado é ruído; confirmar um CANCELADO ressuscita um
    // horário que alguém desmarcou. O par com o caso acima é o que prova que a
    // condição da aba existe — sem ele, um botão solto em toda linha passaria.
    montar(
      [ag("futuro", "confirmed"), ag("cancelado", "cancelled"), ag("ja-foi", "confirmed", -120)],
      vi.fn(),
    );

    for (const [aba, id] of [
      ["proximos", "futuro"],
      ["cancelados", "cancelado"],
      ["passados", "ja-foi"],
    ] as const) {
      abrir(aba);
      expect(
        screen.getByTestId(`linha-${id}`),
        "controle: a linha tem que estar nesta aba",
      ).toBeTruthy();
      expect(
        screen.queryByTestId(`confirmar-${id}`),
        `a aba ${aba} não pode oferecer Confirmar`,
      ).toBeNull();
    }
  });
});

/**
 * ─── A FIAÇÃO, medida no texto ───────────────────────────────────────────
 *
 * O componente é genérico: ele entrega o id e não sabe o que vai virar PATCH.
 * O que não pode se perder num refactor é o outro lado — que a página mande
 * `status: "confirmed"` COM a `revision` daquela linha. Sem `revision`, a
 * escrita atropela quem tiver mexido no compromisso entre a leitura e o clique;
 * o handler exige o campo e o sintoma seria 409 na cara de quem aprova.
 *
 * Render não alcança isto (a página monta providers, hooks e rede), e o que
 * importa cabe numa leitura do arquivo.
 */
describe("a página liga o botão ao PATCH certo", () => {
  const fonte = readFileSync("app/app/agenda/_client.tsx", "utf8");

  it("onConfirmar manda status confirmed com a revision da linha", () => {
    // Recorta o bloco do Confirmar até o botão seguinte: `onConfirmar` é
    // homônimo — o diálogo de marcar horário tem uma prop com o mesmo nome, que
    // recebe um INSTANTE. Casar pelo nome sozinho mede o componente errado.
    const inicio = fonte.indexOf("onConfirmar={(id)");
    expect(inicio, "a página parou de ligar o botão — ele volta a nascer cinza").toBeGreaterThan(
      -1,
    );
    const bloco = fonte.slice(inicio, fonte.indexOf("onRealizado={", inicio));
    expect(bloco).toContain('status: "confirmed"');
    expect(bloco, "PATCH sem revision perde a corrida com quem mexeu na linha").toContain(
      "revision",
    );
  });

  it("o painel de detalhe também confirma, e só quando o pedido está pendente", () => {
    const detalhe = readFileSync("components/agenda/DetalheDoCompromisso.tsx", "utf8");
    expect(detalhe).toContain('decide({ status: "confirmed" })');
    expect(
      detalhe,
      "oferecer Confirmar fora de `pending` é ressuscitar cancelado e reconfirmar confirmado",
    ).toContain('a.status === "pending" ?');
  });
});
