import { tagDeIdioma } from "@/lib/i18n/datas";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

/** Por que esta entrega está saindo. Viaja no `payload` do job. */
export type MotivoDaEntrega = "primeiro_envio" | "remarcado" | "reenvio_manual";

/**
 * O texto que chega ao cliente.
 *
 * Nasce do molde que já existia (`meetingDeliveryBody`) e mantém as duas coisas
 * que ele acertava e que costumam dar errado: formata no fuso do COMPROMISSO
 * (não no do servidor) e traduz para o idioma do CONTATO (não o de quem marcou).
 *
 * O que ele acrescenta é uma frase para a REMARCAÇÃO. Mandar "Sua reunião está
 * marcada para…" duas vezes, com datas diferentes e sem explicação, é pior que o
 * silêncio: a pessoa não sabe qual das duas vale, e a segunda parece erro do
 * sistema.
 *
 * ⚠️ `reenvio_manual` usa a frase do primeiro envio de propósito. Quem clica
 * "Enviar de novo" quer que o cliente receba os dados — anunciar uma mudança que
 * talvez não tenha havido seria inventar um fato.
 */
export function textoDaEntrega({
  motivo,
  startsAt,
  timeZone,
  url,
  idioma,
}: {
  motivo: MotivoDaEntrega;
  startsAt: string;
  timeZone: string;
  url: string | null;
  idioma: Idioma;
}): string {
  const quando = new Intl.DateTimeFormat(tagDeIdioma(idioma), {
    dateStyle: "short",
    timeStyle: "short",
    timeZone,
  }).format(new Date(startsAt));

  const abertura =
    motivo === "remarcado"
      ? traduzir("O horário da sua reunião mudou. Agora é", idioma)
      : traduzir("Sua reunião está marcada para", idioma);

  // Sem link não inventa link: o compromisso pode ser presencial ou por
  // telefone, e prometer uma sala que não existe é pior que não dizer nada.
  const link = url ? ` ${traduzir("Link do Google Meet:", idioma)} ${url}` : "";
  return `${abertura} ${quando} (${timeZone}).${link}`;
}
