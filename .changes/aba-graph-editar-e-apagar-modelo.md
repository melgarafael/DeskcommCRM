---
impacto: capacidade_nova
secao: adicionado
titulo: Aba Graph (Datafy): editar e apagar um modelo sem levar as outras traduções
---

Na aba **Modelos** do canal Graph (Datafy), os botões **Editar** e **Apagar**
voltam a aparecer. Eles ficavam desligados porque apagar um modelo por nome
removia todas as traduções de uma vez, enquanto a tela mostrava um só idioma.
Agora a operação identifica a variante escolhida (nome + idioma) antes de falar
com a plataforma: apagar tira só a tradução selecionada, e editar manda o
conteúdo para a variante certa.

Apagar continua perguntando antes, mostrando onde o modelo está em uso
(follow-up ou prompt de agente), e só confirma com a sua confirmação. Se a
plataforma não devolver a variante, nada é apagado no escuro — a operação
recusa com o motivo.
