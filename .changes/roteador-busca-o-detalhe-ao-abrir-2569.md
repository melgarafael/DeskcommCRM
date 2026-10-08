---
impacto: nada_mudou
secao: corrigido
titulo: Editor do roteador busca o estado atual ao abrir, em vez de confiar só no que veio do servidor
---

Ao abrir o editor de um roteador, a tela montava o rascunho das intenções a partir do estado que veio do servidor e, nos 30 primeiros segundos, tratava esse estado como fresco: o detalhe do roteador não era buscado de novo na API. Agora o estado do servidor vale só enquanto a busca não volta. O editor busca o estado atual ao abrir e o rascunho é atualizado com o que a API devolve, sem sobrescrever o que a pessoa acabou de digitar. Nada precisa ser feito ao atualizar. Contribuição de @webtecnica (relacionado à #2569).
