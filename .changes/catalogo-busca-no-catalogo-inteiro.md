---
impacto: nada_mudou
secao: corrigido
titulo: A tela de Produtos encontra qualquer produto do catálogo, não só os 500 primeiros
---
A tela de Produtos carregava só os 500 primeiros produtos e a busca procurava apenas entre eles. Em catálogos maiores, o restante não aparecia nem buscando pelo nome, embora o atendente de IA continuasse encontrando todos. Agora a busca procura no catálogo inteiro, por nome, código, marca ou categoria, e a lista mostra 50 produtos por página, com o total e botões para avançar e voltar. A busca também deixou de falhar quando o texto tem vírgula ou parênteses, e um `%` digitado passou a ser procurado como caractere, não como curinga. Abrir uma página que não existe mais, por exemplo depois de apagar o último produto dela, leva à última página da busca, e uma falha ao ler o catálogo aparece como erro, não como catálogo vazio. Não é preciso fazer nada na instalação. Crédito: @valterhjr.
