---
impacto: capacidade_nova
secao: adicionado
titulo: A automação consegue mover o card para uma etapa de perda informando o motivo, e a aba Atividade mostra a recusa real em vez de erro interno
---

A ação de mover o card ganha o campo "Motivo da perda", pedido só quando a etapa
de destino fecha o negócio como perdido; os motivos são os mesmos do arrasto no
quadro. Uma automação nova que aponte para etapa de perda sem motivo é recusada
ao salvar. Automações antigas nessa situação continuam sem mover o card, como
já acontecia, e a aba Atividade agora diz o porquê em vez de "erro interno":
abra a automação e escolha o motivo. Contribuição de @webtecnica.
