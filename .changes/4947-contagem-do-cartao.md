---
impacto: nada_mudou
secao: corrigido
titulo: O cartão da campanha conta as empresas que estão na lista
---

O "N empresas" do cartão de uma campanha lia um total guardado que só as operações de ENTRADA de linha atualizavam. Quando empresas saíam — ao levar a lista para outra campanha, ao excluir as desmarcadas ou no expurgo por retenção —, o cartão da campanha de origem continuava com o número antigo. Agora a contagem é feita das empresas que estão na lista, então ela cai junto com a saída, e uma campanha que fica sem nenhuma aparece com 0 em vez de sumir da tela. Nada a fazer na sua instalação.
