---
impacto: nada_mudou
secao: corrigido
titulo: Alterar um ajuste do agente de IA pela API não apaga mais os outros ajustes
---

Uma alteração pela API (`PATCH /api/v1/ai/agents/:id`) que mandava só parte dos ajustes do agente, como a temperatura ou a quantidade de trechos da base de conhecimento, gravava os valores padrão por cima de todos os ajustes que não vieram na alteração. Mudar só a busca na base, por exemplo, voltava a temperatura para o padrão. Agora só muda o que foi enviado, e o resto fica como estava. O cartão novo de comandos pelo celular grava por esse mesmo caminho, e por isso já nasce sem o defeito.
