/**
 * O FORMATO que a rede aceita numa mensagem de saída (A21, TikTok).
 *
 * Hetero-restrição de forma, do mesmo grupo do limite de quantidade
 * (`limites-da-rede.ts`): a plataforma recusa na hora, com `400 PLATFORM_LIMITATION`,
 * e o erro cru que volta ("platform limitation") não diz ao atendente o que fazer.
 * Aqui a recusa é NOSSA, dita antes de o pedido sair, com a saída no texto.
 *
 * Medido em 25/11/2026, documentação do provedor (Zernio), página "TikTok › Direct
 * messages": texto até 6.000 caracteres OU uma imagem (um JPG ou PNG, até 3 MB) —
 * "a request with `message` and an attachment returns 400 PLATFORM_LIMITATION" —,
 * sem vídeo, áudio, arquivo, botões nem respostas rápidas.
 *
 * Puro e síncrono: quem sabe a rede é o adapter. Rede sem formato próprio medido
 * responde `null` (nada a recusar) e nada muda para ela.
 *
 * ## O que NÃO é validado aqui
 *
 * O limite de 3 MB. O adapter não conhece o tamanho da imagem — só a URL assinada —,
 * e baixá-la só para medir custaria uma segunda transferência a cada envio. Imagem
 * acima disso volta do provedor como 400, que já é classificado como falha
 * permanente (não é repetido).
 */
export interface MensagemDeSaida {
  kind: string;
  mime?: string | null;
  legenda?: string | null;
}

const IMAGENS_DO_TIKTOK = new Set(["image/jpeg", "image/jpg", "image/png"]);

/** Texto de GENTE que diz o que o TikTok aceita, ou `null` se esta mensagem pode sair. */
export function recusaDeFormatoDaRede(
  rede: string | null | undefined,
  mensagem: MensagemDeSaida,
): string | null {
  if (rede !== "tiktok") return null;

  if (mensagem.kind === "text") return null;

  if (mensagem.kind !== "image") {
    return (
      "O TikTok só aceita texto ou uma imagem JPG ou PNG de até 3 MB. " +
      "Este tipo de arquivo não foi enviado: mande em texto, ou como imagem."
    );
  }

  const mime = (mensagem.mime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!IMAGENS_DO_TIKTOK.has(mime)) {
    return "O TikTok só aceita imagem JPG ou PNG. Esta imagem não foi enviada: converta o arquivo e envie de novo.";
  }

  if ((mensagem.legenda ?? "").trim() !== "") {
    return (
      "O TikTok não aceita imagem e texto na mesma mensagem. Envie a imagem sem legenda " +
      "e o texto em outra mensagem."
    );
  }

  return null;
}
