---
impacto: capacidade_nova
secao: adicionado
titulo: A instalação pode registrar um servidor MCP externo e o agente passa a chamá-lo
---
Um servidor MCP externo registrado pela instalação passa a ser enxergado e
chamado pelo agente: o registro guarda endpoint e chave em
`organizations.settings.mcp_externo` (merge em dois níveis, SEM migration — o
mesmo bolso de `conversions` do PR #2197), e a descoberta fala o contrato MCP
(`initialize`, `tools/list`, `tools/call`) pelo cliente do próprio
`@modelcontextprotocol/sdk`, com `Authorization: Bearer <chave>` em toda
requisição. As ferramentas anunciadas entram no turno AO LADO das compiladas e
passam pelo MESMO `wrapMcpTool`, então auditoria, papel e escopo valem para elas
— a recusa do ERP (um `403`) sobe como falha auditada e volta em texto para o
modelo, porque a permissão continua morando no servidor, onde o dado está.

Sem registro, nada muda: o catálogo compilado segue sendo a única fonte do
turno e nenhuma chamada de rede é aberta. Servidor registrado fora do ar também
não derruba o turno — ele volta sem as ferramentas remotas, com o motivo no
log. Esta fatia entrega REGISTRÁVEL + INVOCÁVEL e só leitura: a tela em
`/admin`, a escrita remota, o catálogo completo e limites ficam para depois.

Contribuição de @webtecnica (PR #2204, Refs #2147).
