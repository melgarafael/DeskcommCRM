---
impacto: nada_mudou
secao: corrigido
titulo: A instalação e a atualização não constroem mais os índices do acervo antigo
---
A instalação e a atualização do banco não criam mais os dois índices únicos do modelo antigo de acervo (`ai_kbv_one_active_per_agent` e `ai_knowledge_sources_unique_per_agent`): eles eram construídos no começo do arquivo e derrubados no fim pela migration 0181. Num clone que já passou da 0181 e tem dois materiais do mesmo tipo para um agente, essa construção falhava no meio da atualização — e não adiantava nada, porque o fim do arquivo removia o índice de qualquer jeito. O `drop` que limpa quem ainda tem os índices antigos continua no lugar, e o conjunto final de índices é o mesmo.
