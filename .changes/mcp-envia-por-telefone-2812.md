---
impacto: capacidade_nova
secao: adicionado
titulo: A ferramenta de envio do WhatsApp aceita o telefone e abre a conversa sozinha
---

A ferramenta `crm_send_whatsapp_message`, exposta pelo MCP, só mandava mensagem para uma conversa que já existia — era preciso saber o `conversation_id` de antemão. Isso travava o caso de quem atendeu no Instagram ou no Messenger: com o telefone que o cliente informou, o agente não tinha como abrir a conversa no WhatsApp da organização. Agora, quando o `conversation_id` não é informado, a ferramenta aceita `phone_number`: acha (ou cria) o contato pelas grafias do número, escolhe o número de WhatsApp pronto da organização pela mesma regra que o resto do sistema usa — WORKING primeiro, senão qualquer número vivo que mande mensagem — e abre (ou reaproveita) a conversa 1:1 antes de enviar. O freio anti-ban é aplicado antes de abrir, então um envio recusado por espaçamento ou teto do dia não deixa uma conversa vazia nascida. Contato marcado como pessoal continua recusado, e o telefone inválido devolve o motivo. Nenhuma mudança de banco.

Contribuição de @webtecnica (refs #2812).
