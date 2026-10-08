---
impacto: capacidade_nova
secao: corrigido
titulo: O bloco Mover lead no funil agora pede o motivo da perda quando o destino é etapa de perda, e a recusa aparece na linha do tempo
---

Antes, um fluxo com o bloco "mover lead" apontando para a etapa de perda publicava sem pedir motivo nenhum: na hora de rodar, o card não se movia e o fluxo aparecia como concluído, sem dizer que o negócio continuava aberto. Agora o construtor mostra o seletor de "Motivo da perda" com as mesmas opções do "Marcar como perdido" do quadro, e a publicação recusa o fluxo enquanto o motivo não estiver escolhido.

Fluxos já publicados não são reescritos: os que movem para a etapa de perda sem motivo continuam sem mover o card quando o negócio ainda não tem motivo de perda gravado, como antes da atualização. A diferença é que agora a falha aparece na linha do tempo da inscrição, dizendo que o card não foi movido e por quê, e o bloco no construtor avisa "falta o motivo da perda". Para que esses fluxos passem a mover o card, abra o fluxo, escolha o motivo da perda no bloco e publique de novo. O motivo escolhido é gravado no negócio como o do "Marcar como perdido". (Correção de @paulolimajr77.)
