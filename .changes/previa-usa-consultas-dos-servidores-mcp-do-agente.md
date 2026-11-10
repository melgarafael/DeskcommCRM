---
impacto: nada_mudou
secao: corrigido
titulo: O teste do agente e o rascunho do modo assistido passam a usar as consultas dos servidores MCP do próprio agente
---

No Testar e no rascunho do modo assistido, as ferramentas dos servidores MCP cadastrados no próprio agente eram todas recusadas, mesmo as de consulta. Agora a consulta roda quando quem administra a marcou como Leitura e o servidor a declara somente leitura. Ferramenta de escrita, ou sem essa declaração do servidor, continua recusada na prévia. Criado por @webtecnica, a partir do #4317.
