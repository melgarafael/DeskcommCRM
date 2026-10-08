/**
 * O LEMBRETE DE VÉSPERA QUE NASCE VENCIDO (#2223) — a regra, sem banco.
 *
 * O caso medido na issue: o agente marca reunião às 18:30 para as 16h do dia
 * seguinte (21h30 de antecedência) e o lembrete de 1440 min sai às 18:35:01 —
 * um minuto depois de confirmar — e DE NOVO, idêntico, às 18:40:01. Com reunião
 * a mais de 24h não há disparo imediato; o que muda é só isto: a hora do degrau
 * (16:00 de HOJE) já tinha passado quando a reunião foi marcada.
 *
 * Duas regras diferentes saem daí, e este arquivo prende as duas:
 *
 * 1. **Degrau cuja hora passou ANTES da marcação nunca sai.** Não é atraso de
 *    cron — a ocasião de avisar "na véspera" nunca existiu. A régua é
 *    `created_at`, e é ela que `vencidoNaMarcacao` compara.
 * 2. **Uma saída por degrau, mesmo com duas varreduras.** A rota grava
 *    `reminder_sent_offsets_minutes` entre uma varredura e a seguinte, e é o
 *    conjunto gravado que `varredura()` abaixo replica — a prova de que a
 *    segunda rodada não repete a primeira.
 *
 * A regra 3 (issue #2230) é a mesma pergunta com outra régua: **remarcar
 * reposiciona o instante da marcação.** `created_at` não acompanha o horário
 * movido, então a reunião criada 3 dias antes e remarcada às 18:30 para as 16h
 * do dia seguinte mantinha a véspera "vencida desde 16:00 de HOJE" e saía na
 * varredura das 18:35 — a mesma medição da #2223 com a remarcação no meio. O
 * gatilho `trg_starts_at_marked_at` (migration 0536) grava
 * `starts_at_marked_at` a cada mudança de `starts_at`, e `degrausPendentes`
 * prefere ele a `criadoEm`.
 *
 * A regra 4 (issue #2243) fecha o OUTRO lado da remarcação: **remarcar para
 * mais longe REARMA o degrau cujo horário novo passou do último carimbo.**
 * A lista `reminder_sent_offsets_minutes` gravava "saiu" sem data — a véspera
 * da data antiga suprimia a da data nova para sempre, e o cliente ficava sem
 * lembrete algum. `varredura()` passa a replicar também o `reminder_sent_at`
 * do carimbo (`enviadoEm`, gravado junto com a lista, antes do envio), que é
 * contra o que `degrausPendentes` desarma a ocasião que ainda não saiu. Sem
 * `enviadoEm` (controle) a data nova nunca ganha lembrete: é o defeito.
 *
 * O controle de 60 min entra de propósito no mesmo arquivo: o conserto não pode
 * apagar o lembrete que funciona (a regressão silenciosa seria pior que o defeito).
 *
 * A função mora na rota do cron porque é A rota quem decide enviar — o mesmo
 * desenho de `app/api/v1/cron/agenda-reminder/route.test.ts`, que a exercita
 * sem banco; aqui o foco é a sequência de varreduras.
 */
import { describe, expect, it } from "vitest";

import { degrausPendentes } from "@/app/api/v1/cron/agenda-reminder/route";

const d = (iso: string) => new Date(iso);

interface LinhaDeTeste {
  /** Início da reunião. */
  comeca: string;
  /** `created_at` — quando a reunião ORIGINALMENTE foi marcada. */
  criadoEm?: string | null;
  /**
   * `starts_at_marked_at` — quando o horário ATUAL foi gravado na remarcação
   * (#2230). `null`/ausente = nunca remarcada, e aí vale `criadoEm`.
   */
  remarcadoEm?: string | null;
  principal: number;
  extras?: number[] | null;
}

/**
 * Uma varredura do cron: devolve o que sairia e grava o carimbo, exatamente
 * como a rota faz entre uma rodada e a seguinte — é o estado que a segunda
 * varredura lê.
 */
function varredura(
  estado: { enviados: number[] | null; enviadoEm?: string | null },
  linha: LinhaDeTeste,
  agora: string,
): number[] {
  const pendentes = degrausPendentes({
    agora: d(agora),
    comeca: d(linha.comeca),
    principal: linha.principal,
    extras: linha.extras ?? null,
    jaEnviados: estado.enviados,
    criadoEm: linha.criadoEm ? d(linha.criadoEm) : null,
    remarcadoEm: linha.remarcadoEm ? d(linha.remarcadoEm) : null,
    enviadoEm: estado.enviadoEm ? d(estado.enviadoEm) : null,
  });
  estado.enviados = [...new Set([...(estado.enviados ?? []), ...pendentes])];
  // A rota grava `reminder_sent_at` no MESMO carimbo da lista, antes do envio
  // (#2226) — os dois juntos ou nenhum, como no banco. Só havendo o que
  // carimbar, como na rota (`ainda_nao` corta antes).
  if (pendentes.length > 0) estado.enviadoEm = agora;
  return pendentes;
}

describe("o lembrete de véspera (1440 min) e a marcação (#2223)", () => {
  it("marcada às 18:30 para as 16h do dia seguinte (21h30 de antecedência): NÃO sai na primeira varredura", () => {
    // O caso da issue. A hora do degrau é 16:00 de HOJE — duas horas e meia
    // antes de a linha existir.
    const estado = { enviados: null as number[] | null };
    const linha: LinhaDeTeste = {
      comeca: "2026-10-04T16:00:00.000Z",
      criadoEm: "2026-10-03T18:30:00.000Z",
      principal: 60,
      extras: [1440],
    };
    expect(varredura(estado, linha, "2026-10-03T18:35:00.000Z")).toEqual([]);
    // Nem o degrau sozinho, nem os dois juntos: o de 60 continua dormente.
    expect(varredura({ enviados: null }, { ...linha, principal: 1440, extras: null }, "2026-10-03T18:35:00.000Z")).toEqual([]);
  });

  it("início às 21:30 marcado às 18:35: nem a varredura das 18:35 nem a das 18:40 mandam a véspera", () => {
    // As duas horários do relato da issue — e as duas davam o MESMO texto.
    const estado = { enviados: null as number[] | null };
    const linha: LinhaDeTeste = {
      comeca: "2026-10-03T21:30:00.000Z",
      criadoEm: "2026-10-03T18:35:00.000Z",
      principal: 60,
      extras: [1440],
    };
    expect(varredura(estado, linha, "2026-10-03T18:35:00.000Z")).toEqual([]);
    expect(varredura(estado, linha, "2026-10-03T18:40:00.000Z")).toEqual([]);
    expect(estado.enviados).toEqual([]);
  });

  it("duas varreduras dão UMA única saída — o degrau legítimo não repete", () => {
    // Marcada em 02/10 08:00, com a véspera em 03/10 16:00: a hora nasceu
    // DEPOIS da marcação, então o degrau está armado e sai na primeira
    // varredura depois das 16:00 — e só nela.
    const estado = { enviados: null as number[] | null };
    const linha: LinhaDeTeste = {
      comeca: "2026-10-04T16:00:00.000Z",
      criadoEm: "2026-10-02T08:00:00.000Z",
      principal: 60,
      extras: [1440],
    };
    const saidas = [
      ...varredura(estado, linha, "2026-10-03T16:05:00.000Z"),
      ...varredura(estado, linha, "2026-10-03T16:10:00.000Z"),
    ];
    expect(saidas).toEqual([1440]);
  });

  it("o controle do offset 60 continua saindo — e também uma vez só", () => {
    // A véspera já saiu; falta a hora cheia. O conserto de 1440 não pode ter
    // apagado o 60.
    const estado = { enviados: [1440] as number[] | null };
    const linha: LinhaDeTeste = {
      comeca: "2026-10-04T16:00:00.000Z",
      criadoEm: "2026-10-02T08:00:00.000Z",
      principal: 60,
      extras: [1440],
    };
    const saidas = [
      ...varredura(estado, linha, "2026-10-04T15:05:00.000Z"),
      ...varredura(estado, linha, "2026-10-04T15:10:00.000Z"),
    ];
    expect(saidas).toEqual([60]);
  });

  it("cron parado: degrau que venceu DEPOIS da marcação continua saindo atrasado", () => {
    // O outro lado da régua: atraso de cron legítimo não é o defeito da issue,
    // e apagá-lo em silêncio seria a regressão oposta.
    const estado = { enviados: null as number[] | null };
    const linha: LinhaDeTeste = {
      comeca: "2026-10-04T16:00:00.000Z",
      criadoEm: "2026-10-02T08:00:00.000Z",
      principal: 1440,
      extras: null,
    };
    expect(varredura(estado, linha, "2026-10-03T18:00:00.000Z")).toEqual([1440]);
  });

  it("linha que não sabe quando foi marcada mantém o comportamento antigo", () => {
    // `created_at` ausente = guarda fora do caminho: só o degrau que PROVA ter
    // vencido antes da marcação é descartado, nunca um que não dá pra datar.
    const estado = { enviados: null as number[] | null };
    const linha: LinhaDeTeste = {
      comeca: "2026-10-04T16:00:00.000Z",
      criadoEm: null,
      principal: 1440,
      extras: null,
    };
    expect(varredura(estado, linha, "2026-10-03T18:00:00.000Z")).toEqual([1440]);
  });

  it("marcada no instante exato da hora do degrau também é descartada", () => {
    // `<=`, não `<`: lembrete que sai no segundo em que a reunião é marcada é
    // exatamente o que a issue reporta.
    const estado = { enviados: null as number[] | null };
    const linha: LinhaDeTeste = {
      comeca: "2026-10-04T16:00:00.000Z",
      criadoEm: "2026-10-03T16:00:00.000Z",
      principal: 1440,
      extras: null,
    };
    expect(varredura(estado, linha, "2026-10-03T16:00:30.000Z")).toEqual([]);
  });
});

describe("remarcação reposiciona a régua (#2230)", () => {
  it("criada 3 dias antes, remarcada às 18:30 para as 16h do dia seguinte: a varredura das 18:35 NÃO manda a véspera", () => {
    // O caso medido na issue. A hora da véspera NOVA é 16:00 de hoje, que já
    // passou quando o agente gravou o novo horário — a ocasião de avisar "na
    // véspera" desta data nunca existiu.
    const linha: LinhaDeTeste = {
      comeca: "2026-10-04T16:00:00.000Z",
      criadoEm: "2026-09-30T18:30:00.000Z",
      remarcadoEm: "2026-10-03T18:30:00.000Z",
      principal: 1440,
      extras: null,
    };
    expect(varredura({ enviados: null }, linha, "2026-10-03T18:35:00.000Z")).toEqual([]);
    // Os dois horários do relato da issue, que davam o MESMO texto.
    expect(varredura({ enviados: null }, linha, "2026-10-03T18:40:00.000Z")).toEqual([]);
  });

  it("controle: sem a coluna nova a MESMA linha dispara — é a régua antiga que a issue mediu", () => {
    // Sem o `remarcadoEm`, quem lê cai em `criadoEm` (30/09), que é anterior
    // à hora do degrau — e nada descarta. É o `[1440]` da issue.
    const linha: LinhaDeTeste = {
      comeca: "2026-10-04T16:00:00.000Z",
      criadoEm: "2026-09-30T18:30:00.000Z",
      principal: 1440,
      extras: null,
    };
    expect(varredura({ enviados: null }, linha, "2026-10-03T18:35:00.000Z")).toEqual([1440]);
  });

  it("remarcada para uma hora ainda DISTANTE: o degrau continua armado e sai na hora certa", () => {
    // O outro lado da mesma régua: a remarcação não pode APAGAR o lembrete
    // legítimo (a regressão silenciosa seria pior que o defeito).
    const linha: LinhaDeTeste = {
      comeca: "2026-10-05T16:00:00.000Z",
      criadoEm: "2026-10-01T10:00:00.000Z",
      remarcadoEm: "2026-10-03T18:30:00.000Z",
      principal: 1440,
      extras: null,
    };
    expect(varredura({ enviados: null }, linha, "2026-10-04T15:55:00.000Z")).toEqual([]);
    expect(varredura({ enviados: null }, linha, "2026-10-04T16:05:00.000Z")).toEqual([1440]);
  });

  it("remarcação para CURTO prazo mata a véspera que a marcação original deixaria sair", () => {
    // Criada 01/10 para 05/10 16h — véspera armada para 04/10 16h. Remarcada
    // em 03/10 às 18:35 para as 21:30 do mesmo dia: a hora da véspera NOVA é
    // 02/10 21:30, anterior à remarcação.
    const linha: LinhaDeTeste = {
      comeca: "2026-10-03T21:30:00.000Z",
      criadoEm: "2026-10-01T10:00:00.000Z",
      remarcadoEm: "2026-10-03T18:35:00.000Z",
      principal: 1440,
      extras: null,
    };
    expect(varredura({ enviados: null }, linha, "2026-10-03T18:36:00.000Z")).toEqual([]);
    // Controle: com a régua antiga (só `criadoEm`) a mesma linha mandava.
    expect(varredura({ enviados: null }, { ...linha, remarcadoEm: null }, "2026-10-03T18:36:00.000Z")).toEqual([
      1440,
    ]);
  });

  it("o atraso legítimo de cron continua saindo depois de uma remarcação anterior à hora do degrau", () => {
    // Cron parado: a véspera venceu às 16:00 de 03/10 e a varredura só roda às
    // 18:20. A remarcação de 02/10 não muda nada — a hora do degrau nasceu
    // DEPOIS dela, e apagá-la em silêncio seria o defeito oposto.
    const linha: LinhaDeTeste = {
      comeca: "2026-10-04T16:00:00.000Z",
      criadoEm: "2026-09-28T09:00:00.000Z",
      remarcadoEm: "2026-10-02T11:00:00.000Z",
      principal: 1440,
      extras: null,
    };
    expect(varredura({ enviados: null }, linha, "2026-10-03T18:20:00.000Z")).toEqual([1440]);
  });

  it("linha que nunca foi remarcada continua inteiramente sob `created_at`", () => {
    // Sem backfill, dado legado não muda de comportamento: o que a coluna nova
    // faz é acrescentar a régua, não trocar a que já estava valendo.
    const linha: LinhaDeTeste = {
      comeca: "2026-10-04T16:00:00.000Z",
      criadoEm: "2026-10-03T16:00:00.000Z",
      remarcadoEm: null,
      principal: 1440,
      extras: null,
    };
    expect(varredura({ enviados: null }, linha, "2026-10-03T16:00:30.000Z")).toEqual([]);
    expect(
      varredura({ enviados: null }, { ...linha, criadoEm: "2026-10-03T15:00:00.000Z" }, "2026-10-03T16:05:00.000Z"),
    ).toEqual([1440]);
  });
});

describe("remarcar para mais longe rearma o degrau da data nova (#2243)", () => {
  it("a véspera sai para a data antiga, a reunião é movida e a data nova GANHA lembrete", () => {
    // O caso da issue. Criada 01/10 para 04/10 16:00; a véspera (1440) sai
    // em 03/10 16:05, e o carimbo daquela rodada grava lista E instante.
    const estado = { enviados: null as number[] | null, enviadoEm: null as string | null };
    const linha: LinhaDeTeste = {
      comeca: "2026-10-04T16:00:00.000Z",
      criadoEm: "2026-10-01T10:00:00.000Z",
      principal: 1440,
      extras: null,
    };
    expect(varredura(estado, linha, "2026-10-03T16:05:00.000Z")).toEqual([1440]);
    expect(estado.enviados).toEqual([1440]);
    expect(estado.enviadoEm).toBe("2026-10-03T16:05:00.000Z");

    // Remarcada às 18:30 para 11/10 16:00 — mais longe. A véspera NOVA é
    // 10/10 16:00.
    const movida = {
      ...linha,
      comeca: "2026-10-11T16:00:00.000Z",
      remarcadoEm: "2026-10-03T18:30:00.000Z",
    };
    // Primeira varredura depois da remarcação: o lembrete ANTIGO não
    // re-dispara — a ocasião que saiu foi a de 03/10, e ela não existe mais.
    expect(varredura(estado, movida, "2026-10-03T18:35:00.000Z")).toEqual([]);
    // Nada sai cedo demais: a nova véspera ainda é futura.
    expect(varredura(estado, movida, "2026-10-10T15:55:00.000Z")).toEqual([]);
    // Na véspera da data NOVA o degrau está rearma do e sai — uma vez só.
    expect(varredura(estado, movida, "2026-10-10T16:05:00.000Z")).toEqual([1440]);
    expect(varredura(estado, movida, "2026-10-10T16:10:00.000Z")).toEqual([]);
  });

  it("controle: sem o instante do carimbo a MESMA remarcação nunca ganha lembrete — o defeito", () => {
    // A lista sem data não sabe que [1440] é da data antiga: ela suprime a
    // véspera de 10/10 para sempre. É o que o fix tem de mudar.
    const estado = { enviados: [1440] as number[] | null, enviadoEm: null as string | null };
    const movida: LinhaDeTeste = {
      comeca: "2026-10-11T16:00:00.000Z",
      criadoEm: "2026-10-01T10:00:00.000Z",
      remarcadoEm: "2026-10-03T18:30:00.000Z",
      principal: 1440,
      extras: null,
    };
    expect(varredura(estado, movida, "2026-10-10T16:05:00.000Z")).toEqual([]);
    expect(varredura(estado, movida, "2026-10-10T16:10:00.000Z")).toEqual([]);
  });

  it("sem remarcação o carimbo não rearma nada — a ocasião que saiu não sai de novo", () => {
    // O alvo desta linha é o mesmo de quando a véspera saiu (alvo <= carimbo),
    // então a limpeza nem mexe na lista: o supressor segue suprimindo.
    const estado = { enviados: [1440] as number[] | null, enviadoEm: "2026-10-03T16:05:00.000Z" };
    const linha: LinhaDeTeste = {
      comeca: "2026-10-04T16:00:00.000Z",
      criadoEm: "2026-10-01T10:00:00.000Z",
      principal: 1440,
      extras: null,
    };
    expect(varredura(estado, linha, "2026-10-03T16:10:00.000Z")).toEqual([]);
    expect(varredura(estado, linha, "2026-10-04T15:55:00.000Z")).toEqual([]);
  });

  it("a véspera da data nova que JÁ saiu segue suprimida — o carimbo é depois do alvo", () => {
    // Rearmado o degrau, ele sai em 10/10 16:05 e carimba; a varredura
    // seguinte não pode reenviar. É o invariante do #2226 com a limpeza nova.
    const estado = { enviados: [1440] as number[] | null, enviadoEm: "2026-10-10T16:05:00.000Z" };
    const movida: LinhaDeTeste = {
      comeca: "2026-10-11T16:00:00.000Z",
      criadoEm: "2026-10-01T10:00:00.000Z",
      remarcadoEm: "2026-10-03T18:30:00.000Z",
      principal: 1440,
      extras: null,
    };
    expect(varredura(estado, movida, "2026-10-10T16:10:00.000Z")).toEqual([]);
  });

  it("multidegrau: só o degrau cujo alvo novo passou do carimbo rearma; o pendente segue a regra normal", () => {
    // A véspera saiu (1440 carimbado), a hora cheia (60) ainda não. A
    // remarcação rearma a ocasião nova do 1440 e não inventa o 60.
    const estado = { enviados: [1440] as number[] | null, enviadoEm: "2026-10-03T16:05:00.000Z" };
    const movida: LinhaDeTeste = {
      comeca: "2026-10-11T16:00:00.000Z",
      criadoEm: "2026-10-01T10:00:00.000Z",
      remarcadoEm: "2026-10-03T18:30:00.000Z",
      principal: 60,
      extras: [1440],
    };
    expect(varredura(estado, movida, "2026-10-03T18:35:00.000Z")).toEqual([]);
    expect(varredura(estado, movida, "2026-10-10T16:05:00.000Z")).toEqual([1440]);
    // E o 60 continua esperando a hora nova, saindo uma vez só.
    expect(varredura(estado, movida, "2026-10-11T15:05:00.000Z")).toEqual([60]);
    expect(varredura(estado, movida, "2026-10-11T15:10:00.000Z")).toEqual([]);
  });
});


describe("os outros lados do rearma (#2243, triagem do #2249)", () => {
  // A véspera de 04/10 16:00 sai em 03/10 16:05 — o ponto de partida comum.
  const base: LinhaDeTeste = {
    comeca: "2026-10-04T16:00:00.000Z",
    criadoEm: "2026-10-01T10:00:00.000Z",
    principal: 1440,
    extras: null,
  };
  const vespera = () => {
    const estado = { enviados: null as number[] | null, enviadoEm: null as string | null };
    expect(varredura(estado, base, "2026-10-03T16:05:00.000Z")).toEqual([1440]);
    return estado;
  };

  it("linha legada (remarcada antes da 0536, starts_at_marked_at NULL) não rearma — igual à main", () => {
    // Remarcada em 05/10 09:00 para 06/10 08:00, mas a coluna não registrou: a
    // véspera nova (05/10 08:00) já tinha passado na remarcação, e sem a régua
    // dela o #2239 não vê isso. Rearmar soltaria um "véspera" 23h antes da
    // reunião, minutos depois da remarcação — a classe da #2223.
    const estado = vespera();
    const legada = { ...base, comeca: "2026-10-06T08:00:00.000Z" };
    expect(varredura(estado, legada, "2026-10-05T09:05:00.000Z")).toEqual([]);
  });

  it("lista do backfill da 0254 com o principal reduzido depois não rearma — igual à main", () => {
    // A 0254 gravou `[principal ATUAL]` (60) em linha cujo lembrete saiu pelo
    // principal antigo (1440): o 60 nunca saiu de verdade, e o carimbo não é
    // dele. Sem remarcação, nada a rearmar.
    const estado = { enviados: [60] as number[] | null, enviadoEm: "2026-10-03T16:05:00.000Z" };
    const linha = { ...base, principal: 60 };
    expect(varredura(estado, linha, "2026-10-04T15:05:00.000Z")).toEqual([]);
  });

  it("empurrar 30 min depois da véspera NÃO gera uma segunda véspera", () => {
    // Remarcada às 16:20 para 04/10 16:30: a véspera nova (03/10 16:30) cai 25
    // min depois da que acabou de sair — dois textos em sequência.
    const estado = vespera();
    const meiaHora = { ...base, comeca: "2026-10-04T16:30:00.000Z", remarcadoEm: "2026-10-03T16:20:00.000Z" };
    expect(varredura(estado, meiaHora, "2026-10-03T16:35:00.000Z")).toEqual([]);
    expect(varredura(estado, meiaHora, "2026-10-04T16:00:00.000Z")).toEqual([]);
  });

  it("mesmo horário no dia seguinte gera a véspera da data nova — o envio sai minutos DEPOIS do alvo", () => {
    // A véspera saiu às 16:05 (o cron roda a cada 5 min); a nova (04/10 16:00)
    // fica a 23h55 do carimbo. Uma régua de intervalo CHEIO a recusaria e a
    // remarcação mais comum voltaria ao silêncio da #2243.
    const estado = vespera();
    const amanha = { ...base, comeca: "2026-10-05T16:00:00.000Z", remarcadoEm: "2026-10-03T18:00:00.000Z" };
    expect(varredura(estado, amanha, "2026-10-04T16:05:00.000Z")).toEqual([1440]);
    expect(varredura(estado, amanha, "2026-10-04T16:10:00.000Z")).toEqual([]);
  });

  it("empurrar 3 dias gera a véspera da data nova, uma vez só", () => {
    const estado = vespera();
    const tresDias = { ...base, comeca: "2026-10-07T16:00:00.000Z", remarcadoEm: "2026-10-03T16:20:00.000Z" };
    expect(varredura(estado, tresDias, "2026-10-03T16:35:00.000Z")).toEqual([]);
    expect(varredura(estado, tresDias, "2026-10-06T16:05:00.000Z")).toEqual([1440]);
    expect(varredura(estado, tresDias, "2026-10-06T16:10:00.000Z")).toEqual([]);
  });

  it("rearmado mas já vencido na remarcação continua descartado (#2239, linhas com starts_at_marked_at)", () => {
    // Remarcada em 04/10 18:00 para 05/10 17:00: a véspera nova (04/10 17:00)
    // está a mais de um dia do carimbo — o rearme a libera —, mas já tinha
    // passado quando o horário foi marcado. Quem a segura é o #2239.
    const estado = vespera();
    const longe = { ...base, comeca: "2026-10-05T17:00:00.000Z", remarcadoEm: "2026-10-04T18:00:00.000Z" };
    expect(varredura(estado, longe, "2026-10-04T18:05:00.000Z")).toEqual([]);
  });

  it("remarcar duas vezes: cada data nova ganha a sua véspera, uma vez só", () => {
    const estado = vespera();
    const segunda = { ...base, comeca: "2026-10-11T16:00:00.000Z", remarcadoEm: "2026-10-03T18:30:00.000Z" };
    expect(varredura(estado, segunda, "2026-10-10T16:05:00.000Z")).toEqual([1440]);
    expect(varredura(estado, segunda, "2026-10-10T16:10:00.000Z")).toEqual([]);
    const terceira = { ...base, comeca: "2026-10-18T16:00:00.000Z", remarcadoEm: "2026-10-10T20:00:00.000Z" };
    expect(varredura(estado, terceira, "2026-10-10T20:05:00.000Z")).toEqual([]);
    expect(varredura(estado, terceira, "2026-10-17T16:05:00.000Z")).toEqual([1440]);
    expect(varredura(estado, terceira, "2026-10-17T16:10:00.000Z")).toEqual([]);
  });
});
