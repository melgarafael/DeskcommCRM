---
impacto: capacidade_nova
secao: adicionado
titulo: Módulos podem guardar informação própria, e ela aparece na ficha do contato
---

Começa a plataforma de módulos: um módulo de nicho — odontograma de clínica, ficha de imóvel, cardápio de delivery — pode guardar informação própria no sistema, **declarando** quais fichas guarda e quais campos cada ficha tem. Quem escreve o módulo não escreve banco de dados; o próprio servidor cria as tabelas a partir dessa descrição, com as mesmas proteções de isolamento entre empresas que as tabelas do produto têm.

O que isso muda na tela: a ficha de um contato passa a mostrar o que os módulos instalados guardam sobre aquela pessoa, com os nomes que o autor do módulo escolheu e os valores já formatados. Se nenhum módulo com informação própria estiver instalado, nada muda na tela — e é esse o caso de toda instalação hoje, porque o catálogo oficial ainda não publica nenhum módulo desse tipo.

Três proteções ficam valendo desde já:

- as informações de um módulo não são alcançáveis direto pelo navegador: as tabelas do módulo são fechadas para o acesso do navegador, e a leitura passa por uma rota do sistema que confere a empresa de quem pediu;
- a ligação de uma ficha de módulo com um contato é conferida **junto com a empresa dona do contato**, de modo que um módulo não consegue apontar para o cliente de outra empresa na mesma instalação;
- um módulo que falhe não derruba nem esvazia a ficha do contato — o painel dele sai e o resto continua;
- o painel de um módulo só aparece quando há algo para mostrar: na ficha em que o módulo não guardou nada, ele não é desenhado.

Ao juntar dois contatos duplicados, as fichas de módulo passam a acompanhar o contato que ficou, em vez de permanecerem presas ao que saiu da junção.

A atualização pode levar alguns segundos a mais, uma única vez, porque o banco cria um índice novo na tabela de contatos.
