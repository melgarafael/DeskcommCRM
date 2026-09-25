import { tagDeIdioma } from "@/lib/i18n/datas";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

/** Por que esta entrega está saindo. Viaja no `payload` do job. */
export type MotivoDaEntrega = "primeiro_envio" | "remarcado";

/**
 * O texto do compromisso que chega ao cliente.
 *
 * Nasce do molde que já existia (`meetingDeliveryBody`) e mantém as duas coisas
 * que ele acertava e que costumam dar errado: formata no fuso do COMPROMISSO —
 * não no do servidor — e traduz para o idioma do CONTATO, não o de quem marcou.
 *
 * O que ele acrescenta são duas coisas:
 *
 *   1. aceitar **compromisso sem link** — visita e ligação não têm sala, e
 *      prometer uma porta que não existe é pior que não dizer nada;
 *   2. uma frase própria para a **remarcação**. Mandar "está marcado para…"
 *      duas vezes, com datas diferentes e sem explicação, é pior que o silêncio:
 *      a pessoa não sabe qual das duas vale, e a segunda parece erro do sistema.
 *
 * ⚠️ Há UMA régua para este texto, e é esta função. `meetingDeliveryBody`
 * continua exportada (há teste em cima dela) mas passou a DELEGAR: duas réguas
 * para o mesmo texto divergem na primeira mudança, e foi o que já aconteceu com
 * a régua das regras de isolamento.
 *
 * Recorte do PR #803, de @paulolimajr77.
 */
export function textoDoCompromisso({
  motivo = "primeiro_envio",
  startsAt,
  timeZone,
  url,
  idioma,
}: {
  /** Ausente = primeiro envio, que é o comportamento de quem não declara nada. */
  motivo?: MotivoDaEntrega;
  startsAt: string;
  timeZone: string;
  /** `null` = compromisso sem reunião online (presencial, telefone). */
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
      ? url
        ? traduzir("O horário da sua reunião mudou. Agora é", idioma)
        : traduzir("O horário do seu compromisso mudou. Agora é", idioma)
      : url
        ? traduzir("Sua reunião está marcada para", idioma)
        : traduzir("Seu compromisso está marcado para", idioma);
  const link = url ? ` ${traduzir("Link do Google Meet:", idioma)} ${url}` : "";
  return `${abertura} ${quando} (${timeZone}).${link}`;
}
