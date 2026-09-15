---
impacto: nada_mudou
secao: corrigido
titulo: Mover um card para uma etapa de perda sem motivo deixa de dar erro 500
---

Mover um card para uma etapa que fecha o negócio como perdido sem informar o
motivo respondia "Erro inesperado" (500) — e o card não se movia, sem dizer por
quê. Acontecia nos três caminhos que trocam a etapa do negócio: o arrasto no
quadro, o movimento em lote e o movimento feito pelo assistente de IA.

O motivo da perda é exigência do banco desde sempre (a etapa de perda fecha o
negócio, e fechar como perdido sem causa registrada não é permitido). Quem estava
errado era a tela, que deixava a pergunta chegar ao banco e devolvia a recusa como
falha de servidor.

Agora a resposta é a recusa de negócio, com o que fazer: no arrasto, a tela de
motivo pede o motivo antes de mover; no lote, a recusa NOMEIA os cards que ainda
não têm motivo — antes, um único card sem motivo derrubava o lote inteiro; e o
assistente de IA não move o card: ele avisa na Central que o negócio deveria ser
marcado como perdido e que o motivo é uma decisão de quem está no negócio.

Nenhuma ação é necessária na instalação: a regra do banco não mudou e nenhum dado
foi tocado.
