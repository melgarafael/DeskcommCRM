---
impacto: nada_mudou
secao: alterado
titulo: Aprendizados da memória recolhem — um aberto por vez
---

Cada aprendizado aparecia sempre aberto, com corpo, validade e ações na tela ao
mesmo tempo: com dez ou mais, a Memória da IA virava uma parede em que nada se
achava. Agora os aprendizados são um acordeão — todos fechados por padrão, abrir
um fecha o outro, clicar de novo fecha. O corpo, o campo **Vale até** e o botão
de arquivar/reativar continuam iguais; só passam a aparecer na linha aberta.

O acordeão é um componente de lista (`components/ui/accordion.tsx`), sem
biblioteca nova, com `aria-expanded`/`aria-controls` no cabeçalho e o painel
rotulado pelo botão — nasce pronto para a mesma recolha nas etapas do funil
(#4083). Nada muda para quem roda o sistema: não há migration nem ação a fazer.
