---
impacto: nada_mudou
secao: corrigido
titulo: Contato criado ao abrir conversa por telefone (API, MCP) não aparece mais como "tem WhatsApp" sem ninguém saber
---

Quem abria uma conversa por telefone pela API (`POST /api/v1/conversations/open-with-contact`, `POST /api/v1/messages`) ou pela ferramenta MCP `crm_start_conversation_and_send`, com um número que ainda não era de nenhum contato, ganhava um contato novo marcado "WhatsApp: sim". Agora ele nasce "não sei", e vira "sim" quando a pessoa escreve pelo WhatsApp, como antes. A rota e a ferramenta aceitam o campo opcional `phone_whatsapp` (`sim`, `nao` ou `nao_sei`) para o contato que criarem; contato que já existe não muda.
