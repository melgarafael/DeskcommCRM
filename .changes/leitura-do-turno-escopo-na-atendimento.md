---
impacto: nada_mudou
secao: corrigido
titulo: A busca e a ficha de contato numa conversa de atendimento só alcançam o contato do turno
---

A trava do contato do turno protegia as escritas do agente e não protegia as leituras. No
pacote Atender, `crm_search_contacts` era texto livre sobre a base inteira de contatos da
organização — devolvendo telefone e e-mail na própria resposta — e `crm_get_contact` abria a
ficha de qualquer uuid da empresa. Numa conversa com o cliente A, o agente buscava um nome e
recebia o telefone do cliente B; a auditoria gravava sucesso, e o dado saía no WhatsApp de
quem está do outro lado, encaminhável, sem volta.

O contato da conversa agora chega ao handler como contexto de confiança
(`ctx.contatoDoTurno`, injetado pelo runtime — o modelo não escreve esse campo). Com ele, a
busca passa a devolver só o contato desta conversa (e a paginação da varredura da
organização some junto), e a ficha de quem não é o desta conversa é recusada com o motivo em
texto, na mesma forma que a escrita já devolvia — e a recusa entra na auditoria como recusa,
não como sucesso. O Operador, cujo turno também recebe o contato da conversa, passa a ver só
esse contato nas duas ferramentas — o lado seguro, porque ele não fala com o lead. Sem
contato de turno — rota HTTP, MCP externo — nada muda, e a proteção de escrita continua de
pé.

Refs #2158

Contribuição de @webtecnica (#2175).
