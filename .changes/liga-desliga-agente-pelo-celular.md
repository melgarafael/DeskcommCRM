---
impacto: capacidade_nova
secao: adicionado
titulo: Ligar e desligar o agente pelo celular (#on/#off)
---

- **Comandos pelo celular:** o atendente pode pausar e devolver o atendimento
  automático digitando `#off` e `#on` no próprio WhatsApp do celular vinculado
  à organização. Vale **por conversa**, só quando a mensagem inteira é o
  comando, e a pausa é durável — só `#on` (ou o botão "devolver ao automático"
  na tela) religam a IA.
- **Configurável na tela do agente:** cartão **"Comandos pelo celular"** com um
  interruptor. Desligado (padrão), `#on`/`#off` são tratados como texto comum, e
  responder pelo celular apenas pausa a IA como qualquer mensagem.
- **Pausa durável por atendimento manual:** responder o cliente direto do
  celular (fora do CRM) agora pausa a IA até um humano devolvê-la — antes
  expirava sozinho em 60 minutos. O registro das mensagens continua normal.
- O comando é revogado do WhatsApp do cliente logo após ser aplicado, para não
  aparecer como fala de atendimento.

Nada exige ação de quem opera: a atualização entra sem editar `.env` ou compose.
