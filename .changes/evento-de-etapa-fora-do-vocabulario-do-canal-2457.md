---
impacto: nada_mudou
secao: corrigido
titulo: Etapa da Meta com evento que o canal não repassa vira pendência com motivo visível
---

Uma regra de etapa da Meta escolhida com um evento fora do vocabulário do
canal (`QualifiedLead` e `ViewContent` estão na lista da tela e fora de
`ChannelConversionInput`) não tinha caminho quando a organização só tem o
canal intermediado, e a pendência saía como `sem_conexao` — com o texto
"Nenhuma conta de anúncios conectada… Preencha o formulário acima", mandando
a pessoa preencher uma conexão direta que aquela instalação nunca vai ter.
Agora a pendência grava o motivo `evento_fora_do_canal`, que diz o que fazer
(escolher, para a etapa, um evento que o canal repassa — Lead enviado, Início
de compra, Adicionou ao carrinho — ou configurar a conexão direta da Meta), e
o detalhe nomeia o evento que ficou de fora. Compra e
etapas da lista do canal seguem como antes; nada é renomeado no fio, porque
reportar à Meta um nome que não aconteceu seria pior que não reportar.

Contribuição de @webtecnica (#2660, issue #2457).
