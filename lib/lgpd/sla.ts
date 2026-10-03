/**
 * LGPD SLA business-day calculator.
 *
 * Rules (L-04):
 *  - SLA is expressed in Brazilian business days (dias úteis).
 *  - Skip Saturdays (getDay()===6) and Sundays (getDay()===0).
 *  - Skip Brazilian national holidays from HOLIDAYS_BR_ISO.
 *  - If receivedAt itself is not a business day, counting starts on the
 *    next business day (edge: weekend/holiday receipt).
 *
 * ═══ `due_at` É UM DIA CIVIL, E ESTE ARQUIVO É O QUE O DIZ ═══
 *
 * `computeDueAt` devolve a meia-noite UTC do dia útil contado. A coluna
 * `lgpd_requests.due_at` guarda, portanto, um DIA CIVIL do calendário do
 * país — e não um instante em que o prazo acaba. O prazo vai até o FIM
 * daquele dia.
 *
 * Isso não é um detalhe de implementação: é o contrato da coluna, e ele
 * precisa sobreviver a quem lê. Os dois últimos blocos deste arquivo existem
 * porque os consumidores de `due_at` redesenhavam o instante no fuso de QUEM
 * LÊ — e, para quem está a oeste de UTC, o prazo aparecia um dia antes,
 * inclusive no e-mail que vai para o DPO e no balde `overdue` da API.
 *
 * A lista viva desses consumidores, com o que já está corrigido e o que ainda
 * está congelado (e por quê), não mora aqui: mora no teste que a vigia,
 * `tests/unit/lgpd-prazo-e-dia-civil.test.ts`. Ele é o lugar onde uma afirmação
 * de estado não envelhece — porque um consumidor novo o deixa vermelho.
 *
 * Um único escritor de produto grava a coluna (`lib/lgpd/repository.ts`), o que
 * torna a convenção verificável em vez de presumida.
 */

import { HOLIDAYS_BR_ISO } from "./holidays-br";

const _defaultHolidays = new Set(HOLIDAYS_BR_ISO);

/**
 * Format a Date to YYYY-MM-DD (UTC-based, suitable for set lookup when
 * dates are constructed as UTC midnight + 1-day increments).
 */
function toISODateStr(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Returns true when the given Date (treated as a UTC midnight point) is
 * a business day — not Saturday, not Sunday, not in the holidays set.
 */
function isBusinessDay(date: Date, holidays: Set<string>): boolean {
  const dow = date.getUTCDay(); // 0=Sun, 6=Sat
  if (dow === 0 || dow === 6) return false;
  return !holidays.has(toISODateStr(date));
}

/**
 * Advance date by one calendar day (UTC).
 */
function addOneDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}

// ---------------------------------------------------------------------------
// LENDO O DIA QUE A COLUNA GUARDA
//
// Tudo abaixo é PURO, não toca banco e NÃO LANÇA — os consumidores daqui são a
// tela, a API e o e-mail do DPO, e um prazo que derruba a página de compliance
// por um valor torto seria pior que um prazo sem rótulo.
// ---------------------------------------------------------------------------

/** `Date` → `"YYYY-MM-DD"` no MESMO eixo em que `computeDueAt` conta. */
function diaCivilDe(instante: Date): string {
  return toISODateStr(instante);
}

/** `"YYYY-MM-DD"` → milissegundos UTC; `null` quando a data não é uma data. */
function utcDeDiaCivil(dia: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dia);
  if (!m) return null;
  const ano = Number(m[1]);
  const mes = Number(m[2]);
  const diaNum = Number(m[3]);
  // `Date.UTC` normaliza overflow em vez de recusar: "2026-13-45" voltaria como
  // janeiro de 2027, e um prazo lido torto viraria um prazo inventado. A volta
  // confere o que o `Date.UTC` guardou.
  const ms = Date.UTC(ano, mes - 1, diaNum);
  const guardado = new Date(ms);
  if (
    guardado.getUTCFullYear() !== ano ||
    guardado.getUTCMonth() !== mes - 1 ||
    guardado.getUTCDate() !== diaNum
  ) {
    return null;
  }
  return Number.isFinite(ms) ? ms : null;
}

/**
 * O DIA CIVIL que `due_at` representa — `"YYYY-MM-DD"`, ou `null` quando o
 * valor não é uma data.
 *
 * ⚠️ LEIA O PORQUÊ ANTES DE USAR `new Date(due_at)` EM QUALQUER LUGAR.
 *
 * `due_at` guarda a meia-noite UTC de um dia útil. Passar esse instante por um
 * formatador com fuso — `toLocaleString` com `timeZone`, `date-fns` `format`,
 * `differenceInDays` — redesenha o DIA no eixo de quem lê, e o dia civil guardado
 * deixa de ser o dia civil mostrado. Quem lê a oeste de UTC (Brasil, Colômbia,
 * Peru) vê o prazo UM DIA **antes**; a leste (Angola, Lisboa) a meia-noite UTC
 * ainda cai no mesmo dia, e o dia mostrado acerta por acaso. No Brasil, que é
 * onde o produto roda, o prazo aparece no dia anterior.
 *
 * A correção é não "ajustar o fuso", é ler o dia que a coluna guarda — que é o
 * dia que o motor contou.
 */
export function diaDoPrazo(dueAt: string | Date | null | undefined): string | null {
  if (dueAt === null || dueAt === undefined) return null;
  const instante = typeof dueAt === "string" ? Date.parse(dueAt) : dueAt.getTime();
  if (!Number.isFinite(instante)) return null;
  return diaCivilDe(new Date(instante));
}

/**
 * Dias INTEIROS de atraso, contados em DIAS CIVIS. `0` enquanto o dia do prazo
 * não passou — um prazo vence ao FIM do dia, então o dia do prazo não está
 * atrasado, está **hoje**.
 *
 * Subtrair milissegundos e arredondar (`Math.round((agora - due) / 86_400_000)`)
 * erra por dois motivos ao mesmo tempo: pega o dia errado (metade do dia já é o
 * dia seguinte, a oeste de UTC) e arredonda meio dia para cima. O resultado é o
 * alarme anunciando "1 dia(s) em atraso" às 09h do dia do prazo, com o e-mail ao
 * lado afirmando que o prazo vence "amanhã" — dois números que não podem estar
 * certos ao mesmo tempo.
 *
 * `0` para valor ausente ou ilegível: prazo que não se lê não pode virar atraso
 * no alarme de compliance.
 */
export function diasDeAtraso(dueAt: string | Date | null | undefined, agora: Date): number {
  const prazo = diaDoPrazo(dueAt);
  if (prazo === null) return 0;
  const alvo = utcDeDiaCivil(prazo);
  const hoje = utcDeDiaCivil(diaCivilDe(agora));
  if (alvo === null || hoje === null) return 0;
  const dias = Math.round((hoje - alvo) / 86_400_000);
  // `-0` sai quando os dois dias são o mesmo, e `Object.is(-0, 0)` é falso: um
  // consumidor que compara com `toBe(0)` veria vermelho sem motivo nenhum.
  return dias === 0 ? 0 : dias;
}

/**
 * Dias INTEIROS até o prazo: `0` = vence hoje, `1` = amanhã, negativo = passou.
 *
 * O espelho de {@link diasDeAtraso}, para quem precisa da outra ponta do
 * balde (`critical`, "vence em Nd"). Comparar dias civis em vez de milissegundos
 * é o que impede o balde de acender 26 horas antes do prazo.
 */
export function diasAtePrazo(dueAt: string | Date | null | undefined, agora: Date): number {
  const dias = diasDeAtraso(dueAt, agora);
  return dias === 0 ? 0 : -dias; // sem isto sai `-0` no dia do prazo
}

const HORA_MS = 3_600_000;
const DIA_MS = 86_400_000;

/**
 * O INSTANTE em que o dia guardado acaba — a meia-noite UTC do dia seguinte.
 * `null` quando o valor não é uma data.
 *
 * ## Por que esta função existe
 *
 * Ela é a **âncora** de todo consumidor que mede distância até o prazo. Antes de
 * existir, o `+ 86_400_000` estava escrito à mão em dois lugares (aqui e no selo
 * da plataforma), e as duas linhas do tempo das telas de detalhe o esqueciam:
 * mediam até o INÍCIO do dia. Uma âncora escrita à mão é uma âncora que alguém
 * esquece de usar.
 *
 * Medido (`TZ=America/Sao_Paulo`, `due_at = 2026-10-05T00:00:00.000Z`): o dia
 * guardado acaba em `2026-10-06T00:00:00.000Z`, que é **21:00 de 05/10** no
 * Brasil. É a herança do eixo UTC do motor (`computeDueAt`), não desta função —
 * mudar isso é mudar o que a coluna guarda, e é decisão de produto.
 *
 * Devolver o INSTANTE (e não as horas) deixa o chamador escolher a unidade: a
 * barra de progresso quer a razão, a contagem quer as horas, o selo quer comparar
 * contra um teto.
 */
export function fimDoPrazo(dueAt: string | Date | null | undefined): Date | null {
  const prazo = diaDoPrazo(dueAt);
  if (prazo === null) return null;
  const inicio = utcDeDiaCivil(prazo);
  if (inicio === null) return null;
  return new Date(inicio + DIA_MS);
}

/**
 * O corte de "o prazo EXPIRA em até `dias` dias", como instante.
 *
 * ## Por que ele anda um dia para trás
 *
 * `due_at` é o INÍCIO do dia guardado, e quem expira é o **FIM** dele. Então um
 * pedido que expira dentro de `dias` dias tem
 * `due_at + 1 dia <= agora + dias dias`, ou seja
 * `due_at <= agora + (dias - 1) dia`. Um dia, e não "quase" um: a diferença é
 * exatamente `fimDoPrazo(due_at) - due_at`.
 *
 * Medido com `agora = 03/10 09:00` em São Paulo, janela de 5 dias:
 *
 * | dia do prazo | expira em | `due_at <= agora + 5d` | `due_at <= agora + 4d` |
 * |---|---|---|---|
 * | 05/10 | 60h | entra | **entra** |
 * | 07/10 | 108h | entra | **entra** |
 * | 08/10 | 132h | **entra** | **NÃO entra** |
 * | 09/10 | 156h | não entra | não entra |
 *
 * A coluna do meio é o defeito: um pedido que expira em **5 dias e meio** entrava
 * num KPI que promete cinco.
 *
 * Mora aqui, e não em cada consulta, pela mesma razão de `fimDoPrazo`: a âncora
 * escrita à mão é a âncora que alguém esquece de mudar num dos lugares. Hoje há
 * dois consumidores (`admin/dashboard/kpis`, o KPI e o alerta), e os dois leem
 * este.
 */
export function corteDaJanela(agora: Date, dias: number): Date {
  return new Date(agora.getTime() + (dias - 1) * DIA_MS);
}

/**
 * A fração (0..1) da janela entre o recebimento e o FIM do dia do prazo que já
 * passou — a barra das duas telas de detalhe. `0` quando uma das pontas não se
 * lê: barra vazia em vez de `NaN%`.
 *
 * Mora aqui, e não em cada tela, para que o teste meça a conta que a tela faz, e
 * não uma cópia dela.
 */
export function progressoDoPrazo(
  receivedAt: string | Date,
  dueAt: string | Date | null | undefined,
  agora: Date,
): number {
  const fim = fimDoPrazo(dueAt);
  const inicio = new Date(receivedAt).getTime();
  if (fim === null || !Number.isFinite(inicio)) return 0;
  const total = fim.getTime() - inicio;
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, (agora.getTime() - inicio) / total));
}

/**
 * HORAS até o FIM do dia que `due_at` representa — `0` no último minuto do dia,
 * negativo depois dele. `null` quando o valor não é uma data.
 *
 * ## Para quem precisa de horas, e não de dias
 *
 * O e-mail ao DPO fala em **dias** ("1 dia(s) em atraso") e usa
 * {@link diasDeAtraso}. O painel da plataforma fala em **horas** ("12h
 * restantes") e precisa desta. As duas coisas são a mesma âncora — o dia que o
 * motor contou — em unidades diferentes, e é por isso que as duas superfícies
 * viram no mesmo instante.
 *
 * ## O que ela NÃO finge
 *
 * O prazo é contado no eixo UTC pelo motor (`computeDueAt`), e o fim do dia
 * guardado é a meia-noite UTC do dia seguinte. Numa instalação brasileira isso
 * significa que o "fim do prazo" chega às **21h** do dia, três horas antes da
 * meia-noite local. Isso NÃO é deste módulo: é a herança do eixo do motor, e o
 * que este PR garante é só que as três superfícies que leem o prazo
 * (e-mail ao DPO, balde da organização e painel da plataforma) concordem entre
 * si. Mudar o eixo é mudar o que `computeDueAt` grava — mexe em toda linha já
 * existida e é decisão de produto, não correção de leitura.
 *
 * Fracionário de propósito: quem exibe quer o inteiro (`Math.trunc`) e quem
 * compara contra um teto quer comparar as horas cruas. Cortar aqui obrigaria um
 * dos dois a refazer a conta.
 */
export function horasAteOFimDoPrazo(
  dueAt: string | Date | null | undefined,
  agora: Date,
): number | null {
  const fim = fimDoPrazo(dueAt);
  if (fim === null) return null;
  return (fim.getTime() - agora.getTime()) / HORA_MS;
}

/**
 * O prazo no formato de quem lê — `"DD/MM/AAAA"`.
 *
 * Sai do DIA CIVIL, não do instante: `new Date(due_at).toLocaleString("pt-BR",
 * { timeZone: "America/Sao_Paulo" })` devolve `"04/10/2026, 21:00:00"` para um
 * prazo contado no dia 05/10 — o dia anterior, com uma hora que não significa
 * nada (o prazo vai até o fim do dia). A data sai do dia, e o rótulo fica
 * igual em pt-BR e em es, porque `dd/MM/yyyy` é o mesmo nos dois.
 */
export function prazoEmBr(dueAt: string | Date | null | undefined): string | null {
  const dia = diaDoPrazo(dueAt);
  if (dia === null) return null;
  const [ano, mes, diaDoMes] = dia.split("-");
  return `${diaDoMes}/${mes}/${ano}`;
}

/**
 * Compute the due date for an LGPD SLA.
 *
 * @param receivedAt   Timestamp when the request was received.
 * @param businessDays Number of business days allowed (e.g. 15 for redact).
 * @param holidays     Override holiday set; defaults to HOLIDAYS_BR_ISO.
 * @returns            A MEIA-NOITE UTC do N-ésimo dia útil — o DIA CIVIL que a
 *                     coluna `due_at` guarda, e NÃO o instante em que o prazo
 *                     acaba. Para formatar, comparar ou contar, use
 *                     {@link diaDoPrazo} / {@link diasDeAtraso}: redesenhar
 *                     este instante com fuso devolve o dia anterior para quem
 *                     lê a oeste de UTC.
 */
export function computeDueAt(
  receivedAt: Date,
  businessDays: number,
  holidays: Set<string> = _defaultHolidays,
): Date {
  // Normalise to UTC midnight of the received day
  let cursor = new Date(
    Date.UTC(receivedAt.getUTCFullYear(), receivedAt.getUTCMonth(), receivedAt.getUTCDate()),
  );

  // If receivedAt itself is not a business day, advance to the first business day
  if (!isBusinessDay(cursor, holidays)) {
    cursor = addOneDay(cursor);
    while (!isBusinessDay(cursor, holidays)) {
      cursor = addOneDay(cursor);
    }
  }

  // Count N business days starting from (and including) the first business day
  let remaining = businessDays;
  while (remaining > 0) {
    cursor = addOneDay(cursor);
    if (isBusinessDay(cursor, holidays)) {
      remaining--;
    }
  }

  return cursor;
}
