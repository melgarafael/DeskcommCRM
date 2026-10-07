/**
 * AS DUAS CONTAGENS DO PRAZO — os rótulos relativos das duas listas de LGPD.
 *
 * | superfície  | rótulo             | quem mostra                    |
 * |-------------|--------------------|--------------------------------|
 * | plataforma  | `contagemDoPrazo`  | tabela Admin › LGPD            |
 * | organização | `distanciaDoPrazo` | coluna "Vence em" da lista      |
 *
 * ## Por que os dois moram aqui
 *
 * São a mesma pergunta ("quanto falta para este prazo?") com vocabulários
 * diferentes — de propósito, são telas diferentes — e **uma âncora só**: o FIM
 * do dia que `due_at` guarda. Enquanto cada tela fazia a própria conta, elas
 * discordavam entre si; a da organização dizia "atrasado hoje" e a da plataforma
 * "1d em atraso" para a mesma linha. Ver `horasAteOFimDoPrazo`.
 *
 * ## Por que fora dos componentes
 *
 * A coluna decidia um número de compliance, e o número mora em `lib/lgpd/` com o
 * resto da aritmética de `due_at`. Uma função pura é testável; um parágrafo
 * dentro de um componente só se prova pela tela — e a tela é onde este número é
 * lido por quem decide o que cobrar de um cliente.
 *
 * ## O defeito do `contagemDoPrazo` (a coluna da plataforma)
 *
 * A versão anterior ancorava no **instante**:
 *
 * ```ts
 * const hours = differenceInHours(new Date(dueAt), now);
 * if (hours < 0) return `${Math.abs(hours)}h ${t("em atraso")}`;
 * ```
 *
 * `due_at` é a meia-noite UTC do dia útil contado (ver `sla.ts`) — o INÍCIO do
 * dia do prazo, não o fim dele. Medido em São Paulo (UTC−3), com prazo no dia
 * **05/10** (`2026-10-05T00:00:00.000Z`):
 *
 * | quando (hora de São Paulo) | a coluna dizia | o que é verdade |
 * |---|---|---|
 * | 04/10 21:00 | **0h restantes** | o prazo é amanhã |
 * | 04/10 22:00 | **1h em atraso** | o prazo é amanhã, faltam 26 h |
 * | 05/10 09:00 | **12h em atraso** | vence hoje |
 * | 05/10 20:00 | **23h em atraso** | vence hoje, falta 1 h |
 *
 * Um prazo que vence hoje aparecia como doze horas atrasado às nove da manhã,
 * e como "0h restantes" na véspera. A coluna é a que o administrador da
 * plataforma lê para decidir a quem cobrar primeiro.
 *
 * ### A régua agora
 *
 * `horasAteOFimDoPrazo` conta até o FIM do dia guardado, então "em atraso" só
 * aparece depois que o dia acaba. No Brasil isso é a partir de **21h do próprio
 * dia do prazo** — as três horas que faltam até a meia-noite local vêm do eixo do
 * motor (`computeDueAt`), não desta leitura, e é a mesma hora em que o selo da
 * plataforma vira `expired` e o balde da organização vira `overdue`. Ver
 * `horasAteOFimDoPrazo`.
 *
 * Há uma hora de nuance que é o arredondamento, e ela fica: a contagem trunca em
 * direção a zero, como antes, e só a **primeira hora de atraso** é levantada para
 * "1h" — abaixo disso a frase diria "0h em atraso", que é literal mas lê como
 * "nada está atrasado". Fora dessa hora o arredondamento é idêntico ao de antes.
 * Trocar a âncora e o arredondamento no mesmo PR tornaria o conserto impossível
 * de medir.
 *
 * ### O vocabulário NÃO muda
 *
 * As quatro formas de antes continuam as quatro de agora, e nenhuma frase nova
 * entra no dicionário: `—`, `Nh em atraso`, `Nh restantes`, `Nd restantes`.
 * Muda a ÂNCORA, não o texto — um operador que lê esta coluna há meses não
 * encontra nenhuma palavra nova, e a única coisa que muda é ela parar de errar.
 *
 * O arredondamento também é o de antes: `differenceInHours` trunca em direção a
 * zero, e `Math.trunc` faz o mesmo.
 */

import type { AdminLgpdStatus } from "@/hooks/useAdminLGPDRequests";

import { diasDeAtraso, horasAteOFimDoPrazo } from "./sla";

/**
 * Os status em que a coluna não tem nada a dizer: o pedido já terminou.
 *
 * `Set<AdminLgpdStatus>` e não um array solto, porque a comparação precisa do tipo
 * — um `Set<string>` aceitaria qualquer status novo em silêncio, e o pedido
 * concluído com prazo no passado voltaria a exibir uma contagem.
 */
const TERMINAIS: ReadonlySet<AdminLgpdStatus> = new Set<AdminLgpdStatus>(["completed", "failed"]);

/** O que a coluna mostra quando `t` não foi injetado (testes, servidor). */
const semTraduzir = (texto: string) => texto;

/**
 * A frase da coluna "Vence em".
 *
 * `t` é injetado, não importado: o dicionário vive em `lib/i18n/dicionario.ts` e
 * puxá-lo para cá arrastaria o arquivo inteiro para dentro de um componente de
 * tabela. O padrão é o mesmo de `lib/reports/atividades.ts` (`ctx.t ??`).
 *
 * O tipo do status vem do hook (`@/hooks/useAdminLGPDRequests`) em vez de ser
 * reescrito aqui: `lib/ai/case-copy.ts` já faz isso com `CaseStatus`, e duas
 * declarações do mesmo vocabulário divergem no dia em que uma ganha um valor.
 */
export function contagemDoPrazo(
  dueAt: string | null,
  status: AdminLgpdStatus,
  t: (texto: string) => string = semTraduzir,
  agora: Date = new Date(),
): string {
  if (TERMINAIS.has(status)) return "—";
  const horas = horasAteOFimDoPrazo(dueAt, agora);
  if (horas === null) return "—";

  // A VIRADA DE "EM ATRASO" É A MESMA DO SELO, e não a contagem truncada.
  //
  // As duas âncoras viram no MESMO instante: `horas` chega a zero no fim do dia
  // guardado (a meia-noite UTC seguinte), exatamente quando `diasDeAtraso` — o
  // predicado do selo — passa a 1. Quem abria a hora de contradição era o
  // `Math.trunc`: ele leva todo o intervalo (-1h, 0] a zero, e a frase governada
  // por `inteiras < 0` ficava uma hora dizendo "0h restantes" ao lado de um selo
  // **Vencido** (medido: 21:00 a 21:59 de São Paulo do próprio dia do prazo).
  // Com o predicado do selo, a frase vira junto com ele.
  if (diasDeAtraso(dueAt, agora) > 0) {
    // `max(1, …)` só toca a primeira hora: abaixo de 1h de atraso a frase diz
    // "1h" em vez de "0h". Fora dela o arredondamento é o de sempre
    // (`Math.floor` sobre a magnitude, irmão do `Math.trunc` de antes).
    const horasDeAtraso = Math.max(1, Math.floor(-horas));
    return `${horasDeAtraso}h ${t("em atraso")}`;
  }

  const inteiras = Math.trunc(horas);
  if (inteiras < 24) return `${inteiras}h ${t("restantes")}`;
  return `${Math.floor(inteiras / 24)}d ${t("restantes")}`;
}

/**
 * O rótulo da coluna "Vence em" da lista da ORGANIZAÇÃO, e o sinal de urgência
 * que pinta de vermelho o prazo da linha.
 *
 * ## O defeito que este arquivo conserta
 *
 * A versão anterior media a distância até o INÍCIO do dia guardado:
 *
 * ```ts
 * const diffMs = due - now;
 * if (diffMs < 0) { … "atrasado hoje" … }
 * ```
 *
 * Medido em São Paulo (UTC−3), com prazo no dia **05/10**
 * (`2026-10-05T00:00:00.000Z`): por **quase 24 horas** o rótulo dizia "atrasado
 * hoje" enquanto `diasDeAtraso` — o predicado do selo da mesma linha — ainda era
 * 0 (a varredura hora a hora pega 23 amostras). Ia de logo depois de 04/10 21:00
 * até 05/10 21:00, ou seja a linha anunciava atraso no dia INTEIRO anterior ao
 * vencimento. A contagem para frente
 * errava junto, para menos: "em 12h" às 09h de 04/10, quando faltava um dia.
 *
 * ## A régua agora
 *
 * O fim do dia guardado é a âncora, e a virada do atraso é a **mesma do selo**
 * (`diasDeAtraso`), não `horas < 0` — no instante exato do fim os dois discordam
 * por um milissegundo, e é o mesmo motivo que a contagem da plataforma documenta
 * logo acima. A magnitude continua saindo das horas.
 *
 * ## O vocabulário NÃO muda
 *
 * As cinco formas de antes continuam as cinco de agora, e nenhuma frase nova entra
 * no dicionário: `—`, `atrasado hoje`, `Nd atrasado`, `em Nh`, `em Nd`. Muda a
 * âncora e o que cada uma significa — "atrasado hoje" passa a querer dizer
 * "menos de 24 h de atraso", em vez de "depois do início do dia do prazo".
 *
 * ## O `urgent` também muda de âncora
 *
 * `urgent` pinta o prazo de vermelho, e era `diffMs < 2 dias` — dois dias antes do
 * INÍCIO do dia do prazo. Agora são 48 h até o FIM dele. Medido: às 09h de 03/10,
 * com prazo no dia 05/10, o prazo estava em vermelho; agora deixa de estar.
 */
export function distanciaDoPrazo(
  dueAt: string | null,
  t: (texto: string) => string = semTraduzir,
  agora: Date = new Date(),
): { label: string; urgent: boolean } {
  if (!dueAt) return { label: "—", urgent: false };
  const horas = horasAteOFimDoPrazo(dueAt, agora);
  if (horas === null) return { label: dueAt, urgent: false };

  if (diasDeAtraso(dueAt, agora) > 0) {
    const horasDeAtraso = -horas;
    return {
      label:
        horasDeAtraso < 24
          ? t("atrasado hoje")
          : `${Math.floor(horasDeAtraso / 24)}${t("d atrasado")}`,
      urgent: true,
    };
  }

  const urgent = horas < 48;
  if (horas < 24) return { label: `${t("em")} ${Math.floor(horas)}h`, urgent };
  return { label: `${t("em")} ${Math.floor(horas / 24)}d`, urgent };
}
