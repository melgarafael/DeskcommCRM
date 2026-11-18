---
impacto: capacidade_nova
secao: adicionado
titulo: Cada etapa do funil ganhou um "Critério da etapa", e é esse texto que o assistente lê para decidir quando mover o negócio
---

A tela **Etapas do funil** passa a ter, em cada etapa, o campo **Critério da etapa (quando um negócio entra aqui)**: um parágrafo curto, opcional, de até 500 caracteres, com a ajuda "O assistente lê este texto para decidir quando mover o negócio para esta etapa". Apagar o campo devolve a etapa ao estado "sem critério" — a tela não grava texto vazio.

O campo fecha um buraco que existia só na escrita: o assistente **já lia** o critério da etapa e o devolvia nas ferramentas de funil, mas nada na tela escrevia nele, então todo funil criado pelo produto ficava com todas as etapas sem critério. Agora o texto escrito na tela chega ao banco e é o mesmo que o assistente recebe ao consultar as etapas.

Fora da tela, o critério também pode ser gravado pela ferramenta `crm_update_stage`, por uma IA ou integração conectada por MCP com um token de papel gerente (`manager`), com o mesmo limite de 500 caracteres e a mesma regra de vazio. Quando o token é de um agente de IA, a etapa mostra "alterado pelo assistente"; quando é de uma integração comum, "alterado automaticamente pelo sistema". O agente que atende as conversas não alcança essa ferramenta. A gravação segue o registro de auditoria das outras alterações de etapa.

A coluna do quadro ainda **não** exibe o critério como dica: ficou fora deste escopo.
