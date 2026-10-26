/**
 * O que a tela do inbox precisa saber sobre mensagem agendada (#3118) — e só.
 *
 * ─── Por que este arquivo existe, e por que ele não é a régua ───────────────
 *
 * A régua de negócio (piso de 30 s, teto de um ano, teto de partes, tamanho do
 * corpo, quem pode cancelar) mora em `lib/mensagem-agendada/regras.ts` e é lida
 * pela rota, pelo MCP e pelo worker. Aqui ficam apenas as duas conversões que só
 * o NAVEGADOR sabe fazer:
 *
 *   1. `<input type="datetime-local">` fala hora de PAREDE, sem fuso
 *      (`"2026-10-27T09:00"`), e a API grava INSTANTE absoluto (ISO com `Z`).
 *      Quem faz essa conta é o fuso do aparelho de quem agenda — nem o servidor
 *      nem o banco têm como adivinhá-lo.
 *   2. O caminho de volta: instante → o texto que o campo aceita.
 *
 * Nada aqui decide se o agendamento é válido. Quem decide é `validaAgendamento`,
 * chamada pelo diálogo com o MESMO formato que a rota recebe: uma segunda lista
 * de condições na tela divergiria da primeira na primeira correção.
 */
import type { StatusDoPacote } from "@/lib/mensagem-agendada/regras";

/** Uma parte, como a API devolve — o texto já redigido para auditoria. */
export interface ParteAgendada {
  id: string;
  position: number;
  body: string | null;
  media_mime: string | null;
  media_size_bytes: number | null;
  status: "pending" | "sent" | "failed" | "skipped";
  error_code: string | null;
  sent_at: string | null;
}

/** O pacote, como `GET /api/v1/scheduled-messages` devolve. */
export interface PacoteAgendado {
  id: string;
  conversation_id: string;
  scheduled_for: string;
  tz: string;
  status: StatusDoPacote;
  cancel_if_contact_replies: boolean;
  cancel_reason: string | null;
  cancelled_at: string | null;
  last_error: string | null;
  created_at: string;
  parts: ParteAgendada[];
}

/**
 * O que a FAIXA do compositor mostra.
 *
 * `scheduled` é o caso comum — o pacote esperando a hora. `sending` fica porque
 * um pacote que já começou a sair ainda interessa a quem está na conversa (e a
 * faixa diz que não dá mais para cancelar). `partial` e `failed` ficam porque
 * são o desfecho que exige uma pessoa: sem eles, o pacote sumiria da tela no
 * exato momento em que alguém precisa saber que ele não saiu inteiro.
 *
 * `sent` e `cancelled` NÃO entram: viraram histórico, e a conversa já conta essa
 * história pelos balões e pela trilha.
 */
const STATUS_NA_FAIXA: readonly StatusDoPacote[] = ["scheduled", "sending", "partial", "failed"];

export function apareceNaFaixa(status: StatusDoPacote): boolean {
  return STATUS_NA_FAIXA.includes(status);
}

/** Dois dígitos, para o campo e para o ISO local não saírem com `9:5`. */
function doisDigitos(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Instante → o texto de `<input type="datetime-local">`, em hora LOCAL.
 *
 * `toISOString()` não serve: ele converte para UTC, e num aparelho em UTC-3 o
 * campo passaria a mostrar três horas a mais do que a pessoa escolheu.
 */
export function campoDeInstante(quando: Date): string {
  return [
    `${quando.getFullYear()}-${doisDigitos(quando.getMonth() + 1)}-${doisDigitos(quando.getDate())}`,
    `${doisDigitos(quando.getHours())}:${doisDigitos(quando.getMinutes())}`,
  ].join("T");
}

/**
 * O texto do campo → instante ISO absoluto, ou `null` se o campo está vazio ou
 * ilegível.
 *
 * `new Date("2026-10-27T09:00")` — sem sufixo de fuso — é lido pelo navegador
 * como hora LOCAL, que é justamente o que o campo quis dizer. A conversão para
 * `toISOString()` fecha a conta no fuso do aparelho.
 */
export function instanteDoCampo(valor: string): string | null {
  const aparado = valor.trim();
  if (aparado === "") return null;
  const quando = new Date(aparado);
  if (Number.isNaN(quando.getTime())) return null;
  return quando.toISOString();
}

/**
 * O horário que o campo abre preenchido: uma hora à frente, no próximo quarto.
 *
 * Não é "agora" porque o piso da régua é 30 s e porque quem abre o diálogo
 * quer pensar no horário, não corrida contra o relógio. Um quarto de hora é a
 * granularidade em que as pessoas combinam horário.
 */
export function sugestaoDeHorario(agora: Date = new Date()): string {
  const alvo = new Date(agora.getTime() + 60 * 60_000);
  alvo.setMinutes(Math.ceil(alvo.getMinutes() / 15) * 15, 0, 0);
  return campoDeInstante(alvo);
}

/**
 * O fuso IANA do aparelho — o que a API grava junto do instante.
 *
 * Cai em `UTC` só quando o navegador não responde (ambiente sem `Intl`): um
 * fuso inventado seria pior que o neutro, e a régua do servidor valida o nome
 * de qualquer jeito.
 */
export function fusoDoNavegador(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * O que a faixa mostra do CONTEÚDO: a primeira parte com texto, em uma linha.
 *
 * Devolve `null` quando o pacote é só anexo — quem chama decide a palavra
 * (traduzida) para esse caso, em vez de receber português de dentro de um
 * módulo de dados.
 */
export function previaDoPacote(pacote: PacoteAgendado): string | null {
  const comTexto = [...pacote.parts]
    .sort((a, b) => a.position - b.position)
    .find((parte) => (parte.body ?? "").trim() !== "");
  return comTexto?.body?.trim() ?? null;
}
