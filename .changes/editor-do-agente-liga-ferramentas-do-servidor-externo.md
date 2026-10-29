---
impacto: capacidade_nova
secao: adicionado
titulo: O editor do agente lista as ferramentas do servidor MCP externo e liga cada uma no agente
---

No cartão "Usar o servidor de ferramentas externo durante o atendimento", na tela do agente, o dono da instalação passa a ver as ferramentas que o servidor anuncia e marca quais o agente pode usar, escolhendo leitura ou escrita em cada uma. Antes o cartão era só um interruptor: o agente não recebia ferramenta nenhuma do servidor, e o servidor não via requisição nenhuma durante o atendimento.

Durante a conversa com o cliente só rodam as ferramentas marcadas como leitura, e só quando o próprio servidor as declara assim; as de escrita continuam recusadas. Ligar um pacote de capacidades não apaga mais essas escolhas, e elas contam no limite de 27 capacidades por agente.

Crédito: @webtecnica, e @luka1601, que achou o mesmo buraco e o mediu numa instalação em produção (#3578).
