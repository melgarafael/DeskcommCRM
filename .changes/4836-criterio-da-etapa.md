---
impacto: capacidade_nova
secao: adicionado
titulo: Cada etapa do funil ganhou um "Critério da etapa", e é esse texto que o assistente lê para decidir quando mover o negócio
---

A tela **Etapas do funil** passa a ter, em cada etapa, o campo **Critério da etapa (quando um negócio entra aqui)**: um parágrafo curto, opcional, de até 500 caracteres, com a ajuda "O assistente lê este texto para decidir quando mover o negócio para esta etapa". Apagar o campo devolve a etapa ao estado "sem critério" — a tela não grava texto vazio.

O campo fecha um buraco que existia só na escrita: o assistente **já lia** o critério da etapa e o devolvia nas ferramentas de funil, mas nada na tela escrevia nele, então todo funil criado pelo produto ficava com todas as etapas sem critério. Agora o texto escrito na tela chega ao banco e é o mesmo que o assistente recebe ao consultar as etapas.

O mesmo texto também pode ser escrito pelo assistente, pela ferramenta `crm_update_stage`, com o mesmo limite de 500 caracteres e a mesma regra de vazio. Gravar o critério segue o registro de auditoria e a autoria das outras alterações de etapa (a tela mostra "alterado pelo assistente" quando foi a IA).

A coluna do quadro ainda **não** exibe o critério como dica: ficou fora deste escopo.
