import { format, formatDistanceStrict } from "date-fns";
import type { Locale } from "date-fns";

/**
 * O "quando" curto de uma linha de conversa: `14:32`, `há 3 dias`, `28/10`.
 *
 * ─── Por que isto é um arquivo e não uma função privada ────────────────────
 *
 * A régua nasceu dentro de `ConversationListItem` (a linha da Inbox) e o card do
 * funil precisava da MESMA resposta para a última mensagem do negócio. Duas
 * cópias da mesma conta divergem no primeiro ajuste — e aí a Inbox diz "14:32"
 * para a mensagem que o quadro diz ter sido "ontem". Uma função, dois leitores.
 *
 * ─── As três faixas, e o que cada uma responde ─────────────────────────────
 *
 *   hoje    → a HORA (`14:32`): o que importa é se a pessoa respondeu agora;
 *   < 7 dias→ a DISTÂNCIA (`3 dias`): a hora do dia já não decide nada;
 *   resto   → a DATA (`28/10`): o ano fica fora porque a linha é estreita.
 *
 * A distância é `formatDistanceToNowStrict` com o `locale` de quem lê — o
 * "3 dias"/"3 días" vem daí, nunca de string montada à mão.
 *
 * `agora` é parâmetro (e não `new Date()` escondido) para o teste poder fixar o
 * relógio: uma régua que só se testa hoje reprova amanhã por motivo que não é
 * dela.
 */
export function horaCurta(
  iso: string | null | undefined,
  locale: Locale,
  agora: Date = new Date(),
): string {
  if (!iso) return "";
  const quando = new Date(iso);
  // Data inválida (dado legado, string vazia com espaço) não vira "Invalid Date"
  // na tela: a linha fica sem a hora, como se ela não existisse.
  if (Number.isNaN(quando.getTime())) return "";
  if (quando.toDateString() === agora.toDateString()) return format(quando, "HH:mm");
  const dias = (agora.getTime() - quando.getTime()) / 86_400_000;
  // A distância é medida contra o `agora` recebido, e não contra `Date.now()`:
  // uma régua que lê o relógio por dentro não se testa (foi o que aconteceu na
  // primeira versão desta função: o caso dizia "3 dias" e a função, rodando à
  // meia-noite, respondia "4 dias").
  if (dias < 7) return formatDistanceStrict(quando, agora, { locale });
  return format(quando, "dd/MM");
}

/**
 * A data e a hora completas — para o `title` do trecho curto.
 *
 * O curto mente por omissão de propósito (`14:32` não diz o dia), então o
 * detalhe tem de existir a um hover: é a diferença entre "compacto" e "esconde".
 */
export function dataEHoraCompletas(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return "";
  const quando = new Date(iso);
  if (Number.isNaN(quando.getTime())) return "";
  return format(quando, "dd/MM/yyyy HH:mm", { locale });
}
