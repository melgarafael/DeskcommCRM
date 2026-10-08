/**
 * Por que a mensagem livre não sai desta conversa — os textos do COMPOSER.
 *
 * Mora aqui, e não dentro do `InboxLayout`, porque há dois lugares que
 * desabilitam envio na mesma conversa: o composer e o "Enviar link" da
 * videochamada (#2441). Com o texto copiado, o diálogo de vídeo dizia "só um
 * modelo aprovado sai daqui" numa rede social sem modelo nenhum, enquanto o
 * composer, na mesma conversa, mandava aguardar o cliente. Um lugar decide o
 * motivo; os dois o mostram.
 */
import { formatarDecorrido, type EstadoDaJanela } from "@/lib/channels/janela";
import { fonteDeTemplates } from "@/lib/channels/templates-fonte";

type Traduzir = (texto: string) => string;

/** O motivo da janela de 24h fechada, ou `null` quando ela não barra nada. */
export function motivoDaJanelaFechada(
  janela: EstadoDaJanela,
  provider: string | null | undefined,
  t: Traduzir,
): string | null {
  if (janela.tipo !== "fechada") return null;
  // Rede sem modelo aprovado (as redes sociais intermediadas): não há modelo
  // a oferecer, só esperar o cliente escrever de novo.
  if (fonteDeTemplates(provider) === null) {
    return t("Aguarde uma nova mensagem do cliente para reabrir o atendimento nesta rede.");
  }
  if (janela.fechadaHaMs === null) {
    return t(
      "O cliente ainda não escreveu — a janela de 24h nunca abriu. Só um modelo aprovado sai daqui.",
    );
  }
  return `${t("A janela de 24h fechou há")} ${formatarDecorrido(janela.fechadaHaMs)}. ${t("Só um modelo aprovado sai daqui — texto livre é recusado pela plataforma.")}`;
}

/** O motivo de o CONTATO não receber mensagem, ou `null`. */
export function motivoDoContato(
  contato: { is_blocked?: boolean | null; is_anonymized?: boolean | null } | null | undefined,
  t: Traduzir,
): string | null {
  if (contato?.is_blocked) return t("Contato bloqueado — envio de mensagens desabilitado.");
  if (contato?.is_anonymized) return t("Contato anonimizado — não é possível enviar mensagens.");
  return null;
}
