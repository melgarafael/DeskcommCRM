---
impacto: capacidade_nova
secao: adicionado
titulo: Cada turno do agente passa a deixar o registro do que aconteceu nele
---

Toda execução do agente agora deixa uma linha com o que aconteceu naquele turno:
o agente e o modelo que responderam e o total de tokens, custo e latência; as
skills que entraram; as fontes de conhecimento ligadas ao agente, com versão e
hash; as ferramentas que o modelo chamou — com nome, estado (deu certo, falhou
ou foi barrada pelo circuit breaker), erro e duração —; e como o turno
terminou, inclusive quando falha ou é devolvido à fila sem enviar. Vale para a
resposta a uma mensagem, o follow-up e a resposta de caso. O Teste do agente e
os rascunhos do modo assistido deixam a mesma linha, marcada como prévia, para
nunca ser confundida com um turno que falou com alguém de verdade. É o que
faltava para explicar, olhando o histórico, por que o agente respondeu daquele
jeito. A linha ainda não aparece em nenhuma tela: por enquanto ela fica no
banco, para consulta.

Contribuição de @webtecnica (#3169).
