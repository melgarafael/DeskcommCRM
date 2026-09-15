---
impacto: nada_mudou     # nada_mudou | capacidade_nova | exige_acao
secao: corrigido        # adicionado | alterado | corrigido
titulo: Importar a planilha não perde mais o produto de nome longo
---
Quando a planilha não trazia a coluna de código, o nome do produto virava o código
dele, cortado em 60 caracteres. Nome de importado passa disso e difere no fim — 100 ml
e 200 ml, 128 e 256 GB —, então dois produtos diferentes chegavam com o MESMO código: a
segunda linha era recusada como "código repetido na planilha", citando um código que
não existe na planilha, e o produto não entrava no catálogo. Agora o corte leva junto
uma assinatura curta do nome inteiro, o que mantém os 60 caracteres, continua
distinguindo, e a reimportação continua atualizando em vez de duplicar.

O corte também acontecia antes de colapsar os espaços, e um código terminado em espaço
é uma identidade diferente da que a tela grava: editar esse produto pela tela mudava o
código dele, e a importação seguinte criava uma segunda linha do mesmo produto. Isso
acabou junto.

Se o seu catálogo já tem produto de nome muito longo que entrou pela planilha, o código
dele passa a terminar com essa assinatura. A próxima importação da mesma planilha cria
uma linha nova ao lado da antiga, a de código cortado — a antiga pode ser apagada pela
tela do catálogo. Nada a fazer antes de atualizar.

Crédito: @webtecnica.
