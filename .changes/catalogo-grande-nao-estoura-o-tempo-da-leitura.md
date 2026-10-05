---
impacto: nada_mudou
secao: corrigido
titulo: A tela de Produtos de um catálogo grande abre sem "Algo deu errado"
---
Ler o catálogo custava cerca de 2 ms por produto, porque o banco conferia a regra de quem pode ALTERAR preço em cada linha, mesmo numa leitura. A tela de Produtos lê o catálogo inteiro para contar o total, e num catálogo de alguns milhares de produtos a leitura passava do limite de 8 segundos do banco: a tela mostrava "Algo deu errado" em vez da lista. Agora a regra de alteração só vale para alterar, e a leitura de 579 produtos caiu de cerca de 1,2 s para 10 ms. Quem pode ver e quem pode alterar o catálogo continua igual: só gerente e administrador cadastram, alteram e apagam. A atualização aplica o ajuste sozinha, e não é preciso fazer nada na instalação.
