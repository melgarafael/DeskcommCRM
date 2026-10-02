/**
 * A GRADE DESENHA NO FUSO DA ORGANIZAÇÃO, não no do navegador (issue #1362).
 *
 * ─── O defeito ────────────────────────────────────────────────────────────
 *
 * A âncora da agenda já foi para o relógio da organização (#1350), mas a
 * GRADE continuava desenhando hora de parede no relógio de quem abriu a tela:
 * `minutosDesdeOTopo` lia `getHours()`, os rótulos saíam de
 * `format(..., "HH:mm")` e a linha do "agora" subia com o relógio local.
 * `components/agenda/GradeDaAgenda.tsx` não tinha UMA ocorrência de
 * `fuso`/`timezone`/`Intl` antes deste conserto — medido.
 *
 * Para quem tem navegador e organização no mesmo fuso — a maioria, e o CI
 * inteiro quando roda em UTC-3 — a conversão é a IDENTIDADE e nada muda.
 * Por isso o teste não pode escolher o fuso à toa: se ele escolhesse o fuso do
 * próprio ambiente, passaria também com o defeito de volta.
 *
 * ─── A prova ──────────────────────────────────────────────────────────────
 *
 * 1. Um fuso é ESCOLHIDO PORQUE DIFERE do relógio do ambiente no instante fixo
 *    — se nenhum candidato diferir, a asserção de guarda falha e diz por quê.
 * 2. A régua do "agora" e o card ficam onde o fuso da ORGANIZAÇÃO manda, e
 *    NÃO onde o relógio local manda (asserção de desigualdade explícita).
 * 3. Com o fuso igual ao do ambiente, tudo cai exatamente onde caía antes —
 *    a identidade, que é o que protege a maioria de quem nunca viu o defeito.
 *
 * O relógio é injetado: `AGORA` é constante, o instante é fixo, e nenhum caso
 * aqui depende de que horas são quando a suíte roda.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  ALTURA_DA_HORA_PX,
  GradeDaAgenda,
  JANELA_DA_GRADE,
} from "@/components/agenda/GradeDaAgenda";
import type { Agendamento, Pessoa } from "@/components/agenda/tipos";
import { partesNoFuso } from "@/lib/agenda/fuso";

afterEach(cleanup);

/** Quarta, 14:30Z — fixo, para a asserção não virar loteria de horário. */
const AGORA = new Date("2026-09-16T14:30:00Z");

/**
 * Um fuso que NÃO é o do ambiente — E CUJA HORA CAI DENTRO DA GRADE.
 *
 * É a peça que faz o teste provar alguma coisa: `find` devolve o primeiro
 * candidato cuja hora de parede no instante acima É DIFERENTE da hora local.
 * Com o fuso igual ao do navegador, a asserção abaixo seria uma identidade e
 * reprovaria qualquer um — inclusive o código certo.
 *
 * O filtro de faixa também é parte da prova, não enfeite: `ReguaDoAgora`
 * devolve `null` fora da janela da grade (7h–21h), então um fuso cuja parede
 * ficasse às 23:30 derrubaria a régua e o teste falharia por não encontrar o
 * elemento — como falhou na primeira execução, com Tóquio.
 */
const CANDIDATOS = [
  "America/Sao_Paulo",
  "Asia/Tokyo",
  "Pacific/Auckland",
  "Europe/Lisbon",
  "Australia/Sydney",
  "UTC",
];
const NA_GRADE = (f: string) => {
  const h = partesNoFuso(AGORA, f).hora;
  return h >= JANELA_DA_GRADE.primeira && h <= JANELA_DA_GRADE.ultima;
};
const FUSO =
  CANDIDATOS.find(
    (f) => NA_GRADE(f) && partesNoFuso(AGORA, f).hora !== AGORA.getHours(),
  ) ?? "UTC";

const PESSOAS: Pessoa[] = [{ id: "p1", nome: "Ana", trilha: 1 }];

const COMPROMISSO: Agendamento = {
  id: "a1",
  titulo: "Consulta",
  responsavelId: "p1",
  // 14:30Z — meia-noite menos uma hora em São Paulo (11:30), e 23:30 em Tóquio.
  comeca: "2026-09-16T14:30:00Z",
  termina: "2026-09-16T15:15:00Z",
  origem: "ui",
  situacao: "confirmed",
};

/** Minuto do topo da régua, como a grade conta — em HORA DE PAREDE do fuso. */
function topoEsperado(instante: Date, fuso: string): string {
  const p = partesNoFuso(instante, fuso);
  const minutos = (p.hora - JANELA_DA_GRADE.primeira) * 60 + p.minuto;
  return `${(minutos / 60) * ALTURA_DA_HORA_PX}px`;
}

function relogioDoAmbiente(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function desenhar(fuso: string) {
  return render(
    <GradeDaAgenda
      visao="dia"
      // Meio-dia local do dia que o instante cai no ambiente — `ehHoje` compara
      // em hora local, e sem isto a régua não nasceria desenhada.
      ancora={new Date(2026, 8, 16, 12)}
      agora={AGORA}
      fuso={fuso}
      pessoas={PESSOAS}
      agendamentos={[COMPROMISSO]}
    />,
  );
}

function rotuloDoCard(): string {
  return screen.getByTestId("agendamento-a1").textContent ?? "";
}

describe("grade no fuso da organização", () => {
  it("escolhe um fuso que de fato difere do ambiente — sem isto nada é provado", () => {
    expect(FUSO).not.toBe(relogioDoAmbiente());
    expect(partesNoFuso(AGORA, FUSO).hora).not.toBe(AGORA.getHours());
  });

  it("a régua do agora aponta para a hora da ORGANIZAÇÃO, não para a do navegador", () => {
    desenhar(FUSO);
    const regua = screen.getByTestId("regua-do-agora");
    expect(regua.getAttribute("style")).toContain(topoEsperado(AGORA, FUSO));

    // A desigualdade é o teste: se a grade voltar a ler o relógio local, esta
    // linha reprova mesmo que as outras continuem passando.
    expect(topoEsperado(AGORA, FUSO)).not.toBe(topoEsperado(AGORA, relogioDoAmbiente()));
  });

  it("o card mostra a hora de parede da organização", () => {
    desenhar(FUSO);
    const p = partesNoFuso(new Date(COMPROMISSO.comeca), FUSO);
    const dois = (n: number) => String(n).padStart(2, "0");
    const esperado = `${dois(p.hora)}:${dois(p.minuto)}`;

    expect(rotuloDoCard()).toContain(esperado);
    expect(esperado).not.toBe(
      `${String(new Date(COMPROMISSO.comeca).getHours()).padStart(2, "0")}:${String(
        new Date(COMPROMISSO.comeca).getMinutes(),
      ).padStart(2, "0")}`,
    );
  });

  it("fuso igual ao do ambiente: nada muda — é a identidade", () => {
    const ambiente = relogioDoAmbiente();
    desenhar(ambiente);

    if (NA_GRADE(ambiente)) {
      const regua = screen.getByTestId("regua-do-agora");
      expect(regua.getAttribute("style")).toContain(topoEsperado(AGORA, ambiente));

      // ...e NÃO a da organização, provando que o valor não está cravado no teste.
      expect(regua.getAttribute("style")).not.toContain(topoEsperado(AGORA, FUSO));
      return;
    }

    // Fora da janela (7h–21h) a grade não desenha "agora" — e é EXATAMENTE
    // isto que tem de acontecer, para o ambiente quanto para a organização.
    //
    // Com `TZ=Asia/Tokyo` os 14:30Z são 23:30: antes este caso procurava a
    // régua, não achava e reprovava por o elemento sumir. O defeito não era o
    // produto (não pintar o relógio às 23:30 numa grade que vai até 21h é
    // certo), era a asserção exigir o caso feliz de todo fuso. Assim o teste
    // passa em QUALQUER `TZ` e continua falhando se a grade voltar a pintar
    // régua fora da sua própria janela.
    expect(screen.queryByTestId("regua-do-agora")).toBeNull();
    expect(NA_GRADE(ambiente)).toBe(false);
  });
});
