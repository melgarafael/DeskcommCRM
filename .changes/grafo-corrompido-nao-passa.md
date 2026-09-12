---
impacto: nada_mudou
secao: corrigido
titulo: Grafo corrompido deixa de passar no schema
---

O schema do fluxo validava cada nó e cada aresta isoladamente, então um grafo corrompido passava no salvamento: aresta apontando para nó que não existe mais (o estrago que o editor produz ao excluir um nó), dois nós com o mesmo id e duas arestas com o mesmo id. O `flowGraphSchema` agora tem uma catraca de integridade que rejeita os três casos com mensagem explícita dizendo o id a corrigir — `aresta "e-3" aponta para nó inexistente: "no-9"`, `id de nó repetido: "no-1"`, `id de aresta repetido: "e-2"`.

Esses grafos só quebravam longe do defeito: no meio de um disparo, quando uma aresta não resolvia para nó nenhum. Como salvar o rascunho e carregar a versão usam a mesma porta, o erro passa a aparecer na hora de salvar, com o id na mensagem, em vez de virar um caso de suporte.

Quem já tem rascunho corrompido passa a ver o erro ao abrir e salvar o fluxo e precisa corrigir a aresta — não há migração automática, decisão registrada na issue #699. Grafo íntegro e campo desconhecido seguem como antes, com controle nos testes.
