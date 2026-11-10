---
impacto: nada_mudou
secao: corrigido
titulo: A consulta de leitura ao servidor MCP externo conta como registro na conferência de promessa
---

O agente que consultava a agenda ou o pedido no sistema da empresa pelo servidor
MCP externo recebia a data certa ("exame em 30/11 às 17:50") e a "Conferência de
promessa antes de enviar" vetava a resposta como compromisso inventado, porque não
sabia de onde a data vinha. O agente acabava passando a conversa para a equipe.

Agora o resultado de uma ferramenta desse servidor montada como LEITURA (marcada
como leitura no agente e declarada só leitura pelo servidor) entra como registro
consultado no turno. Informar o que ele registra passa; garantir algo além dele,
ou uma oferta, desconto ou condição que o catálogo e o conhecimento não autorizam,
continua vetado. Escrita remota, consulta sem a identidade do contato e recusa de
escopo não contam.

Alcance: só o servidor MCP externo da instalação (Configurações › Servidor MCP
externo). Os servidores cadastrados por agente ainda não entram, e o follow-up não
monta ferramentas do servidor externo.

Crédito: @luka1601, com revisão de @webtecnica.
