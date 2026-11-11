---
impacto: nada_mudou
secao: corrigido
titulo: O teste do agente e o modo assistido passam a usar as consultas do servidor MCP externo
---
Quando a empresa liga um servidor MCP externo (por exemplo, um catálogo de produtos) e marca as ferramentas dele como leitura no agente, o teste do agente e as sugestões do modo assistido recusavam essas consultas com "Ferramenta não autorizada no teste" e o agente passava a conversa para a equipe em vez de responder. Agora as consultas marcadas como leitura rodam no teste e no assistido como já rodavam no automático; as marcadas como escrita continuam bloqueadas. Crédito: @Denispds.
