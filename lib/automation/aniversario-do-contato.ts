/**
 * O ANIVERSÁRIO COM ANTECEDÊNCIA (issue #3726) — a parte que NÃO fala com o banco.
 *
 * ─── O pedido ────────────────────────────────────────────────────────────────
 *
 * O gatilho `contact.birthday` só sabia disparar no próprio dia, às 9h locais.
 * Clínica e salão avisam no começo do mês que o benefício vale o mês inteiro,
 * para a cliente ter tempo de marcar — e não havia caminho automático para isso:
 * nem gatilho mensal, nem "N dias antes", e o filtro de audiência da campanha
 * não conhece a data de nascimento.
 *
 * A saída escolhida (a #3726 oferecia três) é a de MENOR superfície: um campo
 * `dias_antecedencia` no gatilho que já existe, com 0 = no dia (como hoje).
 * Reusa o emissor, a hora local, a varredura horária e a trava que já estavam
 * testados; o gatilho "aniversariantes do mês" (dia 1º) fica como follow-up
 * declarado, porque é um segundo emissor para o mesmo dado.
 *
 * ─── POR QUE A CONTA É EM DIAS DE CALENDÁRIO, E NÃO EM HORAS ─────────────────
 *
 * "Dez dias antes do aniversário" é uma pergunta de calendário: quem nasceu em
 * 05/01 recebe em 26/12 do ano anterior, atravessando a virada do ano. Somar
 * `N * 24h` a um instante erraria na virada de horário de verão (o dia teria 23
 * ou 25 horas) e erraria feio em 29/02. Por isso a conta é `somarDias` sobre a
 * data local (`YYYY-MM-DD`), a mesma função que o gatilho de data do funil usa —
 * um segundo calendário no produto divergiria do primeiro no primeiro conserto.
 *
 * ─── 29 DE FEVEREIRO ─────────────────────────────────────────────────────────
 *
 * Quem nasceu em 29/02 não tem aniversário em três de cada quatro anos. O
 * emissor já resolvia isso deixando o dia 28 responder pelo 29 em ano não
 * bissexto; aqui a regra é a MESMA, aplicada ao dia ALVO do aviso (o
 * aniversário, já deslocado). Assim o comportamento de `dias_antecedencia: 0`
 * continua byte a byte o de antes, e o de N>0 é o mesmo deslocado — em ano não
 * bissexto, o aviso "3 dias antes" de quem nasceu em 29/02 sai no dia 25 (o 28
 * como dia do aniversário), e não some.
 *
 * ⚠️ Este módulo importa só `somarDias` (que é puro). O schema da API e o
 * editor de regras — que roda no NAVEGADOR — leem a configuração daqui; um
 * import de cliente de banco ou de env nesta linha iria para o JavaScript do
 * cliente.
 */
import { somarDias } from "@/lib/automation/gatilho-de-data-do-funil";

/**
 * Quantos dias ANTES do aniversário o aviso pode sair.
 *
 * Zero é o comportamento histórico (no dia). O teto é um ano: acima disso o
 * aviso de um aniversário cairia depois do aniversário seguinte, e o campo
 * deixaria de significar "antes".
 */
export const DIAS_DE_ANTECEDENCIA_MIN = 0;
export const DIAS_DE_ANTECEDENCIA_MAX = 365;

/** O que a regra guarda em `automation_rules.trigger_config`. */
export interface ConfigDoAniversario {
  /**
   * Dias de antecedência. `0` = no dia do aniversário, como sempre foi.
   *
   * Ausente é o caso das regras criadas antes desta versão — elas continuam
   * valendo com 0, e é por isso que o leitor devolve 0 em vez de `null` para
   * `trigger_config` vazio.
   */
  dias_antecedencia: number;
}

/**
 * Lê a configuração do gatilho como ela veio do banco (jsonb) ou da tela.
 *
 * `trigger_config` ausente/vazio → 0 dias. NÃO é tolerância frouxa: é a
 * compatibilidade que impede o deploy de desligar todo aniversário já
 * configurado, que hoje tem `{}` no banco.
 *
 * Devolve `null` para valor torto (string, negativo, fracionário, acima do
 * teto): a varredura roda para todas as organizações, e uma regra torta não
 * pode derrubar as irmãs — ela simplesmente não casa, e o schema da API usa o
 * mesmo leitor para recusar na porta o que o operador mandaria errado.
 */
export function configDoAniversario(bruto: unknown): ConfigDoAniversario | null {
  if (bruto === undefined || bruto === null) return { dias_antecedencia: 0 };
  if (typeof bruto !== "object" || Array.isArray(bruto)) return null;

  const valor = (bruto as Record<string, unknown>).dias_antecedencia;
  if (valor === undefined || valor === null) return { dias_antecedencia: 0 };
  if (typeof valor !== "number" || !Number.isInteger(valor)) return null;
  if (valor < DIAS_DE_ANTECEDENCIA_MIN || valor > DIAS_DE_ANTECEDENCIA_MAX) return null;

  return { dias_antecedencia: valor };
}

/**
 * O dia do ANIVERSÁRIO que a varredura de hoje persegue: hoje local + N dias.
 *
 * `""` para entrada que não é data — não casa com aniversário nenhum, que é a
 * falha fechada (mesma escolha de `somarDias`).
 */
export function aniversarioDoAviso(hojeLocal: string, diasDeAntecedencia: number): string {
  if (!Number.isInteger(diasDeAntecedencia)) return "";
  return somarDias(hojeLocal, diasDeAntecedencia);
}

/**
 * O ano do aniversário — a chave da trava anual.
 *
 * É o ano da DATA CELEBRADA, não o do disparo: quem nasceu em 05/01 e tem aviso
 * de 10 dias é avisado em 26/12 do ano anterior, e essa mensagem pertence ao
 * aniversário de 2027. É o que faz a virada de ano não reabrir o disparo.
 *
 * `null` quando a data é vazia/torta.
 */
export function anoDoAniversario(dataDoAniversario: string): number | null {
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec(dataDoAniversario);
  if (m === null) return null;
  return Number(m[1]);
}

/** Ano bissexto pela regra do calendário (2100 não é, 2000 é). */
function ehBissexto(ano: number): boolean {
  return (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0;
}

/**
 * Quais `birthday_md` esta varredura procura hoje (mês*100 + dia).
 *
 * É a pergunta inteira do gatilho, e ela é feita sobre o dia ALVO — o
 * aniversário deslocado por N. Em ano não bissexto, 28 de fevereiro responde
 * também pelo 29, exatamente como o emissor fazia antes desta feature.
 *
 * Vazio quando o dia alvo não é data: nenhuma consulta casa, nada é emitido.
 */
export function aniversariosAlvo(hojeLocal: string, diasDeAntecedencia: number): number[] {
  const alvo = aniversarioDoAviso(hojeLocal, diasDeAntecedencia);
  if (!alvo) return [];

  const [ano, mes, dia] = alvo.split("-").map(Number);
  if (ano === undefined || mes === undefined || dia === undefined) return [];
  if (!ano || !mes || !dia) return [];

  const md = mes * 100 + dia;
  return md === 228 && !ehBissexto(ano) ? [228, 229] : [md];
}
