/**
 * Capacidades do domínio MARKETING — o que alcança o público sem conversa.
 *
 * Status não é atendimento: não tem destinatário, não abre conversa e não
 * entra no histórico de ninguém. Ele também não é a mesma coisa que "publicar
 * em rede social": é o recado de 24 horas do próprio número do WhatsApp, e é
 * por isso que a operação depende do CANAL — só um número conectado por QR
 * Code publica (capability `statusUpdates`).
 */
import { declararTools } from "./tipos";

export const TOOLS_MARKETING = declararTools([
  {
    name: "crm_publish_whatsapp_status",
    category: "write",
    rotulo: "Publicar imagem no Status do WhatsApp",
    explicacao:
      "Publica uma imagem no Status de um número conectado do CRM, visível só para os " +
      "contatos escolhidos. A peça sai de verdade, no celular de quem vê, e some em 24 horas — não dá para apagar antes.",
    oQueToca: "Status do WhatsApp",
    risco: "critico",
    // "vender", não "atender": Status é peça de divulgação, não de conversa.
    pacotes: ["vender"],
    // Quem publica é uma pessoa que aprovou a arte. O agente conversacional não
    // publica Status no meio de um turno — e `requiresRole: manager` é o que
    // impede de fato (esta marca só declara a intenção).
    apenasHumano: true,
  },
]);
