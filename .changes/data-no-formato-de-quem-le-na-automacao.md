---
impacto: capacidade_nova
secao: adicionado
titulo: Data no formato de quem lê nas mensagens de automação
---

Nas mensagens de automação (WhatsApp e e-mail) e de follow-up, `{{campo|data}}` escreve a data no formato do idioma da organização (dd/mm/aaaa em português e em espanhol) e no fuso dela; `{{campo|data:aaaa-mm-dd}}` escolhe o formato. Valor que não é data sai como está. Campanha e Inbox ainda não leem esse formato: lá o texto sai como foi escrito. Nada a fazer na VPS.

Crédito: @webtecnica.
