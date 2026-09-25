---
impacto: capacidade_nova
secao: adicionado
titulo: O Testar do agente consegue consultar o banco de dados conectado
---

Na aba Teste do agente, as capacidades "Ver as tabelas do banco conectado" e "Buscar dados no banco conectado" eram sempre recusadas com "Esta consulta precisa de um contato real autorizado", e o agente respondia "vou confirmar e te retorno", o que parecia erro de configuração da conexão. Agora o Teste executa as duas consultas como o atendimento real: só leitura, com os mesmos limites de linhas, filtros e tamanho da conexão, e só quando o módulo de banco externo está ligado e há conexão ativa.

Contribuição de @webtecnica (#1636), a partir do relato de @caicoia (#1608).
