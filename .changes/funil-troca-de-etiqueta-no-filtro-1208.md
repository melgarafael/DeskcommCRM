---
impacto: nada_mudou
secao: corrigido
titulo: "No funil, trocar uma etiqueta do filtro por outra não soma mais as duas"
---

No filtro **Tag** do quadro, desmarcar uma etiqueta e logo em seguida marcar outra podia deixar as DUAS escolhidas ("Tag: obra +1") e o quadro vazio. Acontecia quando o servidor demorava a responder à troca de endereço que cada clique faz: o segundo clique partia do filtro de antes do primeiro. Numa VPS lenta, a janela é de quem clica rápido. Agora o quadro aplica o filtro no clique e o endereço alcança depois, então a troca vale o que foi clicado. Nada muda na VPS.
