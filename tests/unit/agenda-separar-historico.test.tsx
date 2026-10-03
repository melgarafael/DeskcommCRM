/**
 * A REPARTIÇÃO DO HISTÓRICO — as quatro abas, e a fronteira que decide cada uma.
 *
 * ─── O defeito que esta cerca fecha ──────────────────────────────────────
 *
 * `separar()` (`components/agenda/HistoricoDaAgenda.tsx`) é quem decide, para
 * TODA linha do histórico, em qual das quatro abas ela aparece — e não tinha um
 * caso sequer. Medido antes de escrever:
 *
 *     grep -rn "HistoricoDaAgenda" tests/   # 1 ocorrência, e é PROSA:
 *                                           # o cabeçalho de tests/e2e/agenda-remarcar-e-cancelar.spec.ts
 *     grep -rln "separar" tests/unit/       # zero
 *
 * A função tem três desvios em quatro linhas (cancelado, pendente, e o instante
 * contra `agora`) e cada um deles erra CALADO: nenhuma exceção, nenhum log,
 * nenhuma tela em branco — a linha simplesmente aparece na aba errada, e a aba
 * errada é uma resposta com cara de certa. Os dois modos que doem:
 *
 *   • um CANCELADO exibido em "Próximos" faz quem atende reservar um horário
 *     que não vai acontecer, e o paciente que cancelou é esperado;
 *   • um compromisso que sai de "Próximos" cedo demais some da lista de quem
 *     abre a tela de manhã — e ninguém sente falta do que não está lá.
 *
 * ─── Por que pelo componente, e não pela função ──────────────────────────
 *
 * `separar()` NÃO é exportada — é `function separar(...)` de módulo. Testá-la
 * exigiria exportá-la, e exportar símbolo só para o teste alcançar é mudar
 * produção para acomodar a cerca. Então a prova é pela tela, que é onde a
 * decisão aparece de qualquer forma: cada aba publica o seu `contador-<aba>`
 * (os quatro visíveis ao mesmo tempo) e a aba aberta publica `linha-<id>`. É o
 * mesmo caminho do molde de `tests/unit/agenda-cartao-conexao-google.test.tsx`.
 *
 * ─── O relógio é INJETADO ────────────────────────────────────────────────
 *
 * `agora` é prop, e todo instante aqui é derivado de `AGORA`, uma constante.
 * Nada de `new Date()`: esta base já pagou o preço de invariante que passava de
 * manhã e reprovava de madrugada.
 */
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { HistoricoDaAgenda, type AbaDoHistorico } from "@/components/agenda/HistoricoDaAgenda";
import { AGENDAMENTOS, ANCORA, PESSOAS } from "@/components/agenda/dados-de-mentira";

import type { Agendamento, SituacaoDoAgendamento } from "@/components/agenda/tipos";

afterEach(cleanup);

/** Quarta-feira, 14h37 — o mesmo instante quebrado da vitrine, e igualmente fixo. */
const AGORA = new Date("2026-08-26T14:37:00.000Z");

function instante(minutosDeDiferenca: number): string {
  return new Date(AGORA.getTime() + minutosDeDiferenca * 60_000).toISOString();
}

/**
 * O tipo de retorno é anotado de propósito: campo obrigatório novo em
 * `Agendamento` reprova aqui no `pnpm typecheck`, e não em runtime na cara de
 * quem for rodar a suíte depois.
 */
function ag(
  id: string,
  comecaEmMinutos: number,
  opcoes: { duracao?: number; situacao?: SituacaoDoAgendamento } = {},
): Agendamento {
  const duracao = opcoes.duracao ?? 30;
  return {
    id,
    titulo: "Consulta",
    quemSeraAtendido: `Paciente ${id}`,
    responsavelId: "ana",
    comeca: instante(comecaEmMinutos),
    termina: instante(comecaEmMinutos + duracao),
    tipo: "Consulta",
    origem: "ui",
    situacao: opcoes.situacao ?? "confirmed",
  };
}

function montar(agendamentos: Agendamento[], agora: Date = AGORA) {
  return render(
    <HistoricoDaAgenda
      agendamentos={agendamentos}
      pessoas={PESSOAS}
      agora={agora}
      fuso="America/Sao_Paulo"
    />,
  );
}

function contador(aba: AbaDoHistorico): number {
  return Number(screen.getByTestId(`contador-${aba}`).textContent);
}

/**
 * Os ids que a pessoa VÊ naquela aba — abre a aba antes, porque só a ativa
 * desenha lista. Ler o contador não bastaria: contador diz QUANTOS, e o defeito
 * que importa é o QUAL (o cancelado que aparece entre os próximos).
 */
function idsNaAba(aba: AbaDoHistorico): string[] {
  fireEvent.click(screen.getByTestId(`aba-${aba}`));
  return Array.from(document.querySelectorAll("[data-testid^='linha-']")).map((el) =>
    (el.getAttribute("data-testid") ?? "").slice("linha-".length),
  );
}

describe("histórico da agenda — a repartição nas quatro abas", () => {
  it("controle de vacuidade: a vitrine inteira cai nas abas, e nada se perde no caminho", () => {
    // Esta sonda enxerga? A vitrine (`dados-de-mentira.ts`) tem os quatro
    // estados de propósito, e não fui eu que a montei. Se a repartição parasse
    // de rodar — render que estoura, testid renomeado, aba que não abre — todos
    // os casos abaixo virariam "zero achados", que é indistinguível de
    // instrumento morto.
    montar(AGENDAMENTOS, ANCORA);

    const soma = contador("proximos") + contador("aguardando") + contador("passados") + contador("cancelados");
    expect(
      soma,
      "toda linha tem que cair em exatamente uma aba: o que some daqui some da tela, " +
        "e o que aparece duas vezes vira compromisso fantasma",
    ).toBe(AGENDAMENTOS.length);

    expect(contador("proximos"), "a vitrine tem futuro e ele precisa chegar em Próximos").toBeGreaterThan(0);
    expect(contador("passados"), "a vitrine tem passado e ele precisa chegar em Passados").toBeGreaterThan(0);
    expect(contador("aguardando"), "a vitrine tem um pendente de propósito").toBeGreaterThan(0);
    expect(contador("cancelados"), "a vitrine tem um cancelado de propósito").toBeGreaterThan(0);

    // E os corpos têm conteúdo: linha renderizada, com o nome de quem é atendido.
    const linhas = idsNaAba("proximos");
    expect(linhas.length, "aba com contador positivo e lista vazia é tela mentindo").toBeGreaterThan(0);
    expect(
      screen.getByTestId(`linha-${linhas[0]}`).textContent?.trim().length ?? 0,
      "linha desenhada em branco é aba que parece cheia e não diz nada a quem abre",
    ).toBeGreaterThan(0);
  });

  it("a fronteira do passado: o que já terminou fica em Passados, o que ainda vai começar em Próximos", () => {
    // O PAR na mesma renderização. Só o lado "passado" passaria com um `true`
    // cravado; só o lado "futuro" passaria com um `false`.
    montar([ag("ja-aconteceu", -90), ag("daqui-a-pouco", 1)]);

    expect(
      idsNaAba("passados"),
      "atendimento concluído que continua em Próximos ocupa a lista de quem abre a agenda de manhã",
    ).toEqual(["ja-aconteceu"]);
    expect(
      idsNaAba("proximos"),
      "compromisso de daqui a um minuto fora de Próximos é o paciente que chega e ninguém esperava",
    ).toEqual(["daqui-a-pouco"]);
  });

  it("no instante EXATO do início ainda é Próximos — quem abre às 14h37 a consulta das 14h37 tem que vê-la", () => {
    // O empate. `isBefore(comeca, agora)` é falso quando os dois são o mesmo
    // instante, e é a resposta certa: o intervalo é [começa, termina), a mesma
    // convenção de `lib/agenda/horarios-livres.ts` ("um compromisso que termina
    // 09:00 não impede o slot que começa 09:00"). Trocar por `<=` mandaria o
    // compromisso para Passados no segundo em que ele começa.
    montar([ag("comeca-agora", 0)]);

    expect(
      idsNaAba("proximos"),
      "empurrar para Passados no tique do início é sumir com a consulta bem na hora em que ela mais importa",
    ).toEqual(["comeca-agora"]);
    expect(contador("passados"), "e nada pode ter caído em Passados").toBe(0);
  });

  it("cancelado no FUTURO é Cancelados, nunca Próximos", () => {
    montar([ag("cancelado-amanha", 24 * 60, { situacao: "cancelled" }), ag("vale-mesmo", 60)]);

    expect(
      idsNaAba("cancelados"),
      "cancelado que não chega em Cancelados não tem onde ser consultado depois",
    ).toEqual(["cancelado-amanha"]);
    expect(
      idsNaAba("proximos"),
      "cancelado listado entre os próximos põe o horário de volta na lista de quem atende: " +
        "a vaga fica bloqueada e a pessoa é esperada para uma consulta que ela desmarcou",
    ).toEqual(["vale-mesmo"]);
  });

  it("...e cancelado no PASSADO também não vira Passados", () => {
    // O outro lado do mesmo desvio: `cancelled` vence o relógio nas DUAS
    // direções. Sem este caso, um `if` que só desviasse o cancelado futuro
    // passaria no caso acima.
    montar([ag("cancelado-ontem", -24 * 60, { situacao: "cancelled" })]);

    expect(
      idsNaAba("cancelados"),
      "cancelado que não chega em Cancelados some do histórico: quem for conferir depois por que "
        + "a vaga ficou vazia não acha o registro de que alguém desmarcou",
    ).toEqual(["cancelado-ontem"]);
    expect(
      contador("passados"),
      "cancelado contado como atendimento passado infla o histórico do que a clínica de fato atendeu",
    ).toBe(0);
  });

  it("pendente é Aguardando confirmação esteja ele no futuro ou já vencido", () => {
    montar([ag("pendente-futuro", 120, { situacao: "pending" }), ag("pendente-vencido", -120, { situacao: "pending" })]);

    expect(
      idsNaAba("aguardando").sort(),
      "'Aguardando confirmação' é a aba de ação de hoje: pendente que cai fora dela nunca é cobrado de ninguém",
    ).toEqual(["pendente-futuro", "pendente-vencido"]);
    expect(contador("proximos"), "pendente ainda não é compromisso firme — anunciá-lo em Próximos promete o que não foi confirmado").toBe(0);
    expect(
      contador("passados"),
      "pendente vencido contado como passado dá por encerrado um pedido que ninguém confirmou",
    ).toBe(0);
  });

  it("o desfecho já registrado continua em Passados — é lá que a decisão 17 lê a situação", () => {
    // `completed` e `no_show` não são desvio nenhum: caem pela regra do relógio.
    // Este caso prende isso porque é de Passados que saem os botões
    // "Realizado"/"Faltou", e um desfecho que caísse noutra aba deixaria os dois
    // sem lugar na tela.
    montar([ag("realizado", -300, { situacao: "completed" }), ag("faltou", -240, { situacao: "no_show" })]);

    expect(
      idsNaAba("passados").sort(),
      "é de Passados que saem 'Realizado' e 'Faltou' (decisão 17): desfecho noutra aba deixa os "
        + "dois botões sem lugar na tela, e o aviso da Central sem para onde mandar o clique",
    ).toEqual(["faltou", "realizado"]);
    expect(contador("cancelados"), "faltar não é cancelar — misturar os dois apaga a diferença entre quem avisou e quem não").toBe(0);
  });

  it("o contador de cada aba é o tamanho da lista daquela aba", () => {
    montar([
      ag("p1", 60),
      ag("p2", 120),
      ag("ontem", -600),
      ag("pend", 90, { situacao: "pending" }),
      ag("canc", 200, { situacao: "cancelled" }),
    ]);

    for (const aba of ["proximos", "aguardando", "passados", "cancelados"] as const) {
      const n = contador(aba);
      expect(
        idsNaAba(aba).length,
        `contador de "${aba}" diverge da lista — e o contador é a única pista de que há ` +
          "trabalho numa aba fechada: se ele mente, o trabalho fica invisível até alguém clicar",
      ).toBe(n);
    }
  });

  it("aba vazia diz o que está vazio, e para de dizer quando chega a primeira linha", () => {
    // O par de presença. Com um `historico-vazio` cravado, o primeiro lado
    // passaria sozinho.
    montar([ag("so-futuro", 45)]);

    fireEvent.click(screen.getByTestId("aba-cancelados"));
    expect(
      screen.getByTestId("historico-vazio").textContent,
      "aba vazia sem frase parece aba que não carregou, e quem atende recarrega a página atrás de dado que não existe",
    ).toContain("Nenhum cancelamento");

    fireEvent.click(screen.getByTestId("aba-proximos"));
    expect(screen.queryByTestId("historico-vazio"), "com linha na aba, o vazio tem que sumir").toBeNull();
    expect(screen.getByTestId("linha-so-futuro")).toBeTruthy();
  });

  /**
   * O RELÓGIO QUE AVANÇA — buraco MEDIDO, não hipótese.
   *
   * `grupos` é `useMemo(..., [agendamentos, agora])`. Tirando `agora` da lista
   * de dependências, os dez casos acima seguem VERDES: cada um monta o
   * componente do zero, e memo nenhum tem como estar velho no primeiro render.
   * Medido assim, com o alvo sabotado:
   *
   *     perl -pi -e 's/\), \[agendamentos, agora\]\);/), [agendamentos]);/' \
   *       components/agenda/HistoricoDaAgenda.tsx
   *     npx vitest run tests/unit/agenda-separar-historico.test.tsx
   *     # antes deste caso: 10 passed | 1 expected fail — verde de ponta a ponta
   *
   * E é alcançável de verdade: `app/app/agenda/_client.tsx` passa
   * `agora={new Date()}`, instante novo a cada render. Com a dependência
   * faltando, a repartição congela no instante em que `agendamentos` mudou pela
   * última vez — e a consulta das 15h fica em "Próximos" às 15h30, prometendo
   * na tela um horário que já passou.
   *
   * A MESMA referência de array nas duas renderizações é o que dá o resultado:
   * lista nova mudaria `agendamentos` e faria o memo recalcular mesmo quebrado,
   * escondendo o defeito.
   */
  it("o relógio avança e a linha muda de aba — sem remontar a tela", () => {
    const linhas = [ag("as-15h", 23)];
    const { rerender } = montar(linhas);

    expect(
      idsNaAba("proximos"),
      "o que ainda vai começar tem que nascer em Próximos, senão o caso abaixo não prova nada",
    ).toEqual(["as-15h"]);

    rerender(
      <HistoricoDaAgenda
        agendamentos={linhas}
        pessoas={PESSOAS}
        agora={new Date(AGORA.getTime() + 60 * 60_000)}
        fuso="America/Sao_Paulo"
      />,
    );

    expect(
      idsNaAba("passados"),
      "passou a hora e a linha continua em Próximos: a tela promete para daqui a pouco um "
        + "horário que já foi, e quem atende só descobre quando o paciente não chega",
    ).toEqual(["as-15h"]);
    expect(contador("proximos"), "e ela não pode ficar contada nos dois lados").toBe(0);
  });

  /**
   * CONTROLE POSITIVO da catraca abaixo, e é um `it` NORMAL de propósito.
   *
   * `it.fails` é satisfeito por QUALQUER falha — import quebrado, testid
   * renomeado, render que estoura. Se a montagem parar de funcionar, a catraca
   * fica verde por não conseguir nem desenhar o cenário, e ninguém vira essa
   * pedra nunca: catraca verde pelo motivo errado é pior que caso ausente,
   * porque parece cobertura.
   *
   * Este caso exercita o MESMO cenário e só exige que ele apareça em ALGUMA
   * aba. Regressão de montagem reprova ALTO aqui, apontando para a montagem,
   * enquanto a catraca seguiria muda.
   */
  it("controle positivo: o compromisso EM ANDAMENTO é desenhado em alguma aba", () => {
    montar([ag("em-andamento", -5, { duracao: 30 })]);

    const soma = contador("proximos") + contador("aguardando") + contador("passados") + contador("cancelados");
    expect(soma, "se ele não está em aba nenhuma, a catraca abaixo é ruído").toBe(1);
  });

  /**
   * CATRACA — defeito medido, não teste desligado.
   *
   * `separar()` decide "passado" por `isBefore(comeca, agora)`, e só olha o
   * COMEÇO. Uma consulta que começou às 14h32, dura 30 minutos e está
   * ACONTECENDO às 14h37 é classificada como passada. Consequências, as duas
   * na mesma linha:
   *
   *   1. ela some de "Próximos" no minuto em que começa — quem abre a tela
   *      durante o atendimento não vê o que está em curso;
   *   2. ela aparece em "Passados" oferecendo "Realizado" e "Faltou" (decisão
   *      17) enquanto a pessoa ainda está na sala: o produto pergunta se
   *      aconteceu antes de ter acontecido, e "Faltou" clicado ali é falta
   *      registrada em cima de quem compareceu.
   *
   * O resto da casa já trata o compromisso como ocupado até `termina` — a
   * consulta de sobreposição de `lib/agenda/consulta.ts` filtra por
   * `starts_at < ate AND ends_at > de`. Aqui `termina` não é lido.
   *
   * UMA asserção só, e é deliberado: `it.fails` é satisfeito pela PRIMEIRA que
   * falha, então asserção extra seria letra morta enquanto o defeito existir, e
   * estrearia sem cobertura no dia do conserto.
   *
   * No dia em que a fronteira passar a olhar `termina`, este caso REPROVA por
   * ter passado, e quem consertar é obrigado a vir tirar o `.fails`.
   */
  it.fails("o compromisso EM ANDAMENTO ainda é Próximos — começou, mas não terminou", () => {
    montar([ag("em-andamento", -5, { duracao: 30 })]);

    expect(
      idsNaAba("proximos"),
      "o que está acontecendo agora sai da tela de quem atende e reaparece em Passados " +
        "oferecendo 'Faltou' para quem está na sala",
    ).toEqual(["em-andamento"]);
  });
});
