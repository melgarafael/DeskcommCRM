---
impacto: nada_mudou
secao: corrigido
titulo: O banco de dados conectado deixa de aparecer para o assistente quando o módulo está desligado, e tabelas com maiúscula passam a ser achadas
---

Com o módulo de banco de dados externo desligado em Admin › Sistema, o assistente e o cliente MCP externo ainda recebiam as duas ferramentas do banco conectado e respondiam "não foi possível abrir a conexão"; agora elas simplesmente não existem para eles. E quando o banco de outro sistema tem tabelas com letra maiúscula (comum em aplicações feitas com ORM), o assistente passa a achar a tabela mesmo que o cliente escreva o nome em minúscula, em vez de responder que ela não existe.
