/**
 * O FECHAMENTO NA GRADE — a faixa fechada de "Dias fora da rotina" em INSTANTES.
 *
 * `calendar_availability_exceptions` guarda o fechamento em minutos de parede
 * (`exception_date` + `start_minute..end_minute`), e o motor de horários livres
 * os lê no fuso DA JORNADA DA PESSOA (`lerJornadaDoBanco(schedule).jornada.timezone`,
 * em `consulta.ts`). A grade desenha em outro eixo: instantes, posicionados no
 * fuso da ORGANIZAÇÃO. Alguém tem que fazer a travessia, e ela tem de ser a
 * MESMA do motor — senão a faixa cinza cairia numa hora e os horários deixariam
 * de ser oferecidos em outra, e a tela mentiria sobre o que o cliente vê.
 *
 * Por isso a conversão mora aqui, no servidor, com as peças do próprio motor
 * (`paredeDeMinutos` + `instanteDe`), e a tela só posiciona instantes prontos —
 * a mesma divisão de `GET /api/v1/agenda/horarios-livres`, em que a grade
 * "não recalcula jornada, exceção nem buffer: ela posiciona a resposta".
 *
 * ─── O fuso quando a pessoa não tem jornada legível ───────────────────────
 *
 * Sem jornada o motor não oferece horário nenhum, então o fechamento não muda
 * nada na oferta — mas ele continua sendo um dado que a pessoa cadastrou e que
 * a lista de "Dias fora da rotina" mostra. Desenhá-lo no fuso da organização é
 * o que a pessoa leu ao cadastrar; escondê-lo faria a grade e a lista
 * discordarem sobre o mesmo dia.
 */
import { instanteDe } from "./fuso";
import { paredeDeMinutos } from "./horarios-livres";
import { lerJornadaDoBanco } from "./jornada";

/** O que a grade recebe: um fechamento já em instantes, de uma pessoa. */
export type FechamentoDaGrade = {
  id: string;
  /** Quem está fechado — a grade filtra pela mesma pessoa que os agendamentos. */
  responsavelId: string;
  /** ISO-8601 (UTC). */
  comeca: string;
  termina: string;
  /** O "Motivo (opcional)" de quem fechou — DADO DO OPERADOR, nunca traduzido. */
  motivo: string | null;
};

/** O fuso em que o MOTOR lê as exceções desta pessoa (o mesmo de `consulta.ts`). */
export function fusoDasExcecoes(scheduleDoBanco: unknown, fusoDaOrganizacao: string): string {
  const leitura = lerJornadaDoBanco(scheduleDoBanco);
  return leitura.ok ? leitura.jornada.timezone : fusoDaOrganizacao;
}

/** Uma linha de exceção em instantes, no fuso da regra. `24:00` vira a meia-noite seguinte. */
export function instantesDaExcecao(
  linha: { exception_date: string; start_minute: number; end_minute: number },
  fuso: string,
): { comeca: string; termina: string } {
  const [ano = 1970, mes = 1, dia = 1] = linha.exception_date.split("-").map(Number);
  return {
    comeca: instanteDe(paredeDeMinutos(ano, mes, dia, linha.start_minute), fuso).toISOString(),
    termina: instanteDe(paredeDeMinutos(ano, mes, dia, linha.end_minute), fuso).toISOString(),
  };
}
