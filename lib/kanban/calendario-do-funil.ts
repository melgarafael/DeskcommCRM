import type { Lead } from "@/lib/types/leads";

/**
 * As datas do funil em dias de calendário (#2770).
 *
 * ─── Por que isto é módulo puro ────────────────────────────────────────────
 *
 * A visão Calendário do funil é a pergunta "quem embarca esta semana?" feita
 * sobre campos personalizados (`data_inicio`, `data_fim`, data do evento). O
 * corte que ela responde — QUEM ENTRA NUM DIA — é decisão, não apresentação:
 * é o que o operador confere e o que o teste da issue cobra. Deixá-lo dentro do
 * componente tornaria a única prova dela um render de jsdom, e a régua de "sem
 * data não aparece" ficaria dependente de a grade inteira montar.
 *
 * ─── A regra de quem aparece ───────────────────────────────────────────────
 *
 * Só entra no dia quem TEM data válida no campo escolhido. Um negócio sem
 * preenchimento não é colocado em "hoje", nem no fim do mês, nem numa lixeira
 * visual: ele não tem dia na grade, e essa ausência é a informação — é ela que
 * diz ao operador que falta preencher o campo.
 */

/**
 * `YYYY-MM-DD` de uma data no fuso de quem lê.
 *
 * Os campos de data do funil são gravados pelo `<input type="date">`, então a
 * forma usual é a data pura — e é POR ISSO que ela não passa por `new Date()`
 * antes: `new Date("2026-03-10")` é meia-noite em UTC, e quem acorda antes do
 * UTC veria 09/03. O valor date-only é lido como pedaços e conferido contra o
 * calendário (`2026-02-30` não existe, logo não é data).
 */
function chaveDoDia(data: Date): string {
  const mes = String(data.getMonth() + 1).padStart(2, "0");
  const dia = String(data.getDate()).padStart(2, "0");
  return `${data.getFullYear()}-${mes}-${dia}`;
}

export { chaveDoDia };

const RE_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * O dia que um valor de campo significa, ou `null` se ele não é data.
 *
 * `null` é o estado NORMAL de "ainda não preenchido" e também o de "veio lixo":
 * a grade trata os dois do mesmo jeito — não aparece. Uma data cheia (ISO com
 * hora, vinda de API ou de importação) também vale, aí pelo dia LOCAL do
 * carimbo.
 */
export function diaDe(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const bruto = valor.trim();
  if (!bruto) return null;

  const pedacos = RE_DATA.exec(bruto);
  if (pedacos) {
    const [, anoTxt, mesTxt, diaTxt] = pedacos;
    const ano = Number(anoTxt);
    const mes = Number(mesTxt);
    const dia = Number(diaTxt);
    const conferido = new Date(ano, mes - 1, dia);
    const existe =
      conferido.getFullYear() === ano &&
      conferido.getMonth() === mes - 1 &&
      conferido.getDate() === dia;
    return existe ? `${anoTxt}-${mesTxt}-${diaTxt}` : null;
  }

  const cheia = new Date(bruto);
  return Number.isNaN(cheia.getTime()) ? null : chaveDoDia(cheia);
}

/**
 * Teto do intervalo entre dois campos, em dias.
 *
 * Sem teto, um contrato vencendo em 2040 encheria a grade inteira do mês com o
 * mesmo negócio e esconderia quem tem data nele. 366 dias cobre qualquer
 * período que um calendário de mês ou semana mostrará de verdade; passando
 * disso, o negócio fica no dia do campo inicial — continua VENDO a data que
 * começou tudo, que é a pergunta original.
 */
const LIMITE_DO_INTERVALO = 366;

/**
 * Os dias em que o negócio aparece: o do campo inicial, e — se houver um
 * segundo campo escolhido e ele for coerente — todos os dias do intervalo.
 *
 * Fim ANTES do início não é intervalo (é dado errado, e andar para trás
 * preencheria dias que já passaram com um "retorno" anterior à ida): vale só o
 * dia do início.
 */
export function diasDoNegocio(
  lead: Lead,
  campo: string,
  campoFim?: string | null,
): string[] {
  const inicio = diaDe(lead.custom_fields?.[campo]);
  if (!inicio) return [];
  if (!campoFim || campoFim === campo) return [inicio];

  const fim = diaDe(lead.custom_fields?.[campoFim]);
  if (!fim || fim < inicio) return [inicio];

  const [ano1, mes1, dia1] = inicio.split("-").map(Number);
  const [ano2, mes2, dia2] = fim.split("-").map(Number);
  const cursor = new Date(ano1!, mes1! - 1, dia1!);
  const limite = new Date(ano2!, mes2! - 1, dia2!);

  const dias: string[] = [];
  while (cursor <= limite && dias.length < LIMITE_DO_INTERVALO) {
    dias.push(chaveDoDia(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dias;
}

/**
 * Dia → negócios que aparecem nele, na ordem da lista do funil.
 *
 * Um `Map` e não um objeto: as chaves são datas, que o JS trata como texto — e
 * quem lê a grade quer "o dia", não "a chave".
 */
export function negociosPorDia(
  leads: readonly Lead[],
  campo: string,
  campoFim?: string | null,
): Map<string, Lead[]> {
  const porDia = new Map<string, Lead[]>();
  for (const lead of leads) {
    for (const dia of diasDoNegocio(lead, campo, campoFim)) {
      const doDia = porDia.get(dia);
      if (doDia) doDia.push(lead);
      else porDia.set(dia, [lead]);
    }
  }
  return porDia;
}

/**
 * O mês em grade de 7 colunas, começando no domingo — o mesmo desenho do
 * calendário de tarefas, para as duas telas não discordarem de onde a semana
 * começa. `null` preenche os dias que sobram antes e depois do mês.
 *
 * O nome do mês e o dia da semana NÃO são arrays em português: quem monta a
 * grade só precisa dos NÚMEROS, e a palavra é do `Intl` na tela.
 */
export function gradeDoMes(ano: number, mes: number): (Date | null)[] {
  const primeiroDiaDaSemana = new Date(ano, mes, 1).getDay();
  const diasNoMes = new Date(ano, mes + 1, 0).getDate();
  const grade: (Date | null)[] = Array<Date | null>(primeiroDiaDaSemana).fill(null);
  for (let dia = 1; dia <= diasNoMes; dia++) grade.push(new Date(ano, mes, dia));
  while (grade.length % 7 !== 0) grade.push(null);
  return grade;
}

/** Os 7 dias da semana que contêm `data`, domingo primeiro (mesma grade do mês). */
export function diasDaSemana(data: Date): Date[] {
  const domingo = new Date(data.getFullYear(), data.getMonth(), data.getDate() - data.getDay());
  return Array.from({ length: 7 }, (_, i) =>
    new Date(domingo.getFullYear(), domingo.getMonth(), domingo.getDate() + i),
  );
}
