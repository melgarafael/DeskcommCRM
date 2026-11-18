---
impacto: nada_mudou
secao: corrigido
titulo: A cerca do curso confere rota, âncora e alvo de destaque contra o fonte da tela
---

As lições do curso ilustrado são dado (`curso/licoes/*.json`), e a cerca que existia conferia a forma do módulo e que a tela ensinada estava no menu. O caminho de cada passo, porém, não era lido: trocar `/admin/sistema` por uma rota inexistente, ou o alvo de um destaque por um seletor que não existe em tela nenhuma, deixava a suíte verde. Quem reclamava era o capturador, já com o app aberto — ou seja, a lição quebrada chegava a quem está aprendendo.

Agora `curso/licoes-apontam-para-a-tela.test.ts` compara com o repositório, não com uma lista escrita à mão: `Passo.rota` é conferido contra a árvore `app/` (e os hrefs de `lib/navigation/catalogo.ts`); cada `antes: rolar #ancora` procura o `id` no fonte da tela daquela rota, seguindo o grafo de imports a partir do `page.tsx`; cada destaque, ação e clique procura o literal em `app/`, `components/` e `lib/`; e todo `role` é conferido contra os papéis ARIA. A cerca velha continua onde estava: esta soma.

O que não dá para provar no fonte — alvo montado em tempo de execução com dado semeado (`Acompanhar ${nome}`, `passo-titulo-${i}`) — ficou numa lista declarada, `curso/divida-de-alvos.json`, com motivo por tipo: 398 alvos de 5.112, cada um identificado por módulo, lição, passo, campo e posição. Declarar ali não é aprovar: alvo novo que não exista no fonte reprova o teste, e a dívida não aceita entrada repetida nem entrada cujo alvo foi apagado ou já passou a existir no fonte. O teto que fica declarado: um alvo cujo começo casa o prefixo fixo de um texto montado no código (`salvar-${x}` aceita qualquer `salvar-…`) conta como provado. Hoje são 332 alvos nessa situação, 296 deles identificadores de teste.

Nenhum conteúdo de lição foi reescrito. Quem não roda o curso não vê diferença no produto.

Contribuição de @webtecnica, a partir dos achados das ondas das issues #4762 e #4761.
