---
impacto: nada_mudou
secao: corrigido
titulo: O rodapé volta a mostrar a versão que está no ar, e não a de um rollback antigo
---

Quando uma atualização pela tela falha e o app volta sozinho para a versão
anterior, o sistema passa a mostrar essa versão anterior — o que está certo:
naquele momento o código baixado no servidor já é o novo, mas o app que subiu é
o velho, e quem sabe qual dos dois está no ar é o registro da tentativa.

O que faltava era o fim dessa validade. O app troca de versão por outros
caminhos que não passam por essa tela — um deploy automático, um comando no
terminal, a atualização feita à mão —, e nenhum deles registra uma tentativa
nova. Sem isso, a tentativa que falhou continuava sendo a última notícia, para
sempre: numa instalação real, o rodapé anunciou por oito dias uma versão de 28
de agosto, atravessando vários deploys, enquanto a versão no ar era outra.

Agora a tentativa antiga só nomeia a versão no ar enquanto for a notícia mais
recente. Se o servidor reportou a versão depois de a tentativa ter terminado, é
o servidor que vale. Isso conserta junto duas coisas que bebiam da mesma fonte:
o aviso de "atualização disponível", que comparava contra a versão errada, e as
notas de versão, que começavam a listar de um ponto errado do histórico.

Nada muda para quem opera: nenhuma configuração nova, nenhum passo de
atualização, nenhuma mudança no banco.
