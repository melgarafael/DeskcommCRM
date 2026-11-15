---
impacto: nada_mudou
secao: corrigido
titulo: O vínculo entre um card e a sua continuação em outro funil só é gravado pelo servidor
---

Quando um negócio é levado para outro funil, o card novo guarda de onde veio (`source_metadata.clonado_de`) e o card de origem guarda para onde foi (`source_metadata.movido_para`). A automação usa esse vínculo para reconhecer a continuação de um negócio. As duas chaves passam a ser escritas só pelo servidor, como já acontecia com a prova de origem da Meta: a sessão do navegador continua editando o resto de `source_metadata`, e "Levar para outro funil" segue funcionando igual. Vale daqui para a frente; vínculos já gravados não são reescritos.
