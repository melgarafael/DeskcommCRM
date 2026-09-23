---
impacto: nada_mudou
secao: corrigido
titulo: O MCP passa a ter teto de chamadas por token, por organização e para escrita
---

O endereço que as ferramentas de IA usam para conversar com o sistema (`/api/mcp`) não limitava quantas vezes um token válido chamava as ferramentas. Um agente externo em laço podia disparar mensagens de WhatsApp sem parar, e o WhatsApp restringe e bane o número por volume.

Agora cada token pode fazer até 60 chamadas por minuto, a organização inteira até 600 por minuto (somando todos os tokens dela) e cada token até 30 chamadas por minuto nas ferramentas que alteram dados, como a que envia mensagem. Passando do teto, a chamada é recusada antes de a ferramenta rodar, a resposta diz quando tentar de novo e a recusa fica registrada no log de auditoria. A IA do próprio sistema não passa por esse teto.

Se o Redis ficar inalcançável, a contagem passa a ser feita na memória de cada processo do app, e numa instalação com mais de uma cópia do app o teto vale por cópia.

Contribuição de @Alencaf (#1446).
