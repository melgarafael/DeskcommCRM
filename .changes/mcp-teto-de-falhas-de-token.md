---
impacto: nada_mudou
secao: corrigido
titulo: O MCP passa a contar token inválido e a barrar quem insiste
---

O endereço que as ferramentas de IA usam para conversar com o sistema (`/api/mcp`) recusava token inválido sem contar a recusa. Cada recusa custava uma consulta ao banco e ninguém era barrado: dava para varrer tokens sem limite e de graça, e um token já revogado podia ser martelado de vários endereços ao mesmo tempo sem que nada reagisse.

Agora a recusa conta em dois lugares: por origem (30 recusas em 5 minutos) e pelo próprio valor apresentado (5 recusas em 5 minutos — a chave é o resumo do valor, nunca o valor em si). Estourado o teto, a resposta é `429`. Token válido em uso não entra na conta, e falha do banco — que é problema nosso, não de quem chamou — não tranca ninguém.

Contribuição de @webtecnica (#1447).
