---
impacto: nada_mudou
secao: corrigido
titulo: Ao importar um fluxo de follow-up inválido, as frases genéricas da lista de problemas saem em português ou espanhol
---

Quando o arquivo de um fluxo importado não passava na conferência, a lista de problemas mostrava o caminho até o campo seguido de uma frase em inglês (por exemplo, «Invalid UUID» ou «Invalid input: expected object, received undefined»). Agora essas frases genéricas — tipo errado, campo faltando, formato inválido — saem no idioma de quem importa, em português ou espanhol, e o caminho até o campo continua o mesmo. As regras específicas do fluxo que já tinham frase própria (como «min_ms must be <= max_ms») continuam com a frase de antes, algumas ainda em inglês. Achado na prova do #3056 de @salomaobatistamkt.
