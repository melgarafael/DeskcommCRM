---
impacto: nada_mudou
secao: corrigido
titulo: Se a sua atualização para a 1.119 parou com erro no banco, basta atualizar de novo
---

Em algumas instalações, a atualização da 1.118 para a 1.119 parava na etapa do banco com `cannot change name of input parameter "c"`. O sistema continuava no ar na 1.118, mas o campo que diz quem cuida de cada conversa ficava numa versão antiga. Numa empresa sem agente de IA ativo, as conversas sem dono podiam aparecer como "automático" em vez de irem para a fila.

O arquivo do banco dava um nome a esse parâmetro a cada atualização e depois dependia de outras etapas para tirar o nome. Quando essas etapas não tinham efeito, a atualização parava. Agora o nome nunca é dado, e um banco que ficou preso nesse ponto é corrigido na própria atualização.

**Se a sua atualização para a 1.119 parou com erro no banco, basta atualizar de novo**, pelo caminho que você já usa. Não precisa voltar de versão nem rodar nenhum comando no banco.
