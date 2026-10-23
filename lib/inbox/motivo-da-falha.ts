import type { Message } from "@/lib/types/messaging";

/**
 * O MOTIVO de uma mensagem que ficou `failed` — a régua do selo "Falhou".
 *
 * ─── Por que como módulo, e não inline (era inline) ────────────────────────
 *
 * A régua nasceu no tooltip do balão (`components/inbox/MessageBubble.tsx`) e
 * passou a valer para o toast do encaminhamento (#2835): quando o envio falha,
 * a bolha no destino mostra "Falhou" com o motivo no tooltip e quem encaminhou
 * lê o MESMO motivo no toast. Duas cadeias montadas à mão divergiriam no dia em
 * que uma delas ganhasse um ramo — e o sintoma seria a tela e o toast contando
 * histórias diferentes sobre a mesma linha `failed`.
 *
 * A precedência é a do dado: `error_message` (o que o canal disse, já gravado
 * pelo envio) vence `error_code` (o código curto que o adaptador devolve),
 * que vence o genérico. Os textos passam por `t()` porque a mensagem pode vir
 * de um código do NOSSO dicionário; o que o provedor mandou em texto livre
 * atravessa `traduzir` como está — dado, não interface, e traduzir seria
 * errado.
 */
export function motivoDaFalhaDaMensagem(
  mensagem: Pick<Message, "error_message" | "error_code">,
  t: (texto: string) => string,
): string {
  if (mensagem.error_message) return t(mensagem.error_message);
  return mensagem.error_code ? t(mensagem.error_code) : t("Erro desconhecido");
}
