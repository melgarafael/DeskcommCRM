---
impacto: nada_mudou
secao: corrigido
titulo: A recusa de devolver ao automático a conversa de outro atendente chega traduzida em espanhol
---

O botão **Devolver ao automático** recusa, para um atendente, a conversa que tem
dono e é de outra pessoa: só um gerente devolve. A recusa já era essa, mas a
frase viajava escrita na rota — e o guarda de espanhol deste repositório varre o
AST das telas, não o das rotas. Na interface em espanhol, o atendente barrado
lia a recusa em português.

Agora a frase tem entrada em `lib/i18n/dicionario.ts` e chega em espanhol a quem
usa a interface nesse idioma: «Esta conversación es de otro atendente. Pídele a
un gerente o asume la conversación.» O caminho de quem pode continua igual — o
dono da conversa, um gerente, e a conversa sem dono seguem devolvendo ao
automático.
