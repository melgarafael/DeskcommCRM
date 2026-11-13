---
impacto: capacidade_nova
secao: adicionado
titulo: Cada funil tem as suas categorias de perda, e a categoria sobrevive ao renomear do motivo
---

As categorias que agrupam os motivos de perda eram do produto — Cliente,
Concorrência, Mérito, Nós e Ausência, fixas no código —, e a tela de
Configurações › Funis não deixava nada mudar. Uma clínica não perde por
"Concorrência", e uma loja que precisa separar "Risco" de "Operacional" não tinha
onde cadastrar. Agora cada funil tem a própria lista, editada na tela do funil:
acrescentar, renomear e esconder. Quem nunca mexeu continua vendo as cinco de
fábrica, e as categorias que os motivos já usam entram na lista — inclusive a que
foi gravada à mão antes desta tela existir, sem precisar de migração de dado.
Esconder uma categoria só deixa de oferecê-la aos outros motivos: o motivo que já
era dela continua agrupado no relatório de Perdas e continua mostrando a
categoria no próprio menu. Renomear uma categoria leva junto os motivos que a
usavam.

O mesmo menu de motivo passou a listar as categorias do funil, e o filtro do
quadro e o relatório de Perdas acompanham: motivo sem categoria tem o rótulo
explícito "Sem categoria" em vez de sumir de qualquer recorte por categoria.

Na mesma tela, a chance de fechamento e o aviso de equipe de cada etapa seguem
gravados ao salvar e recarregar — o ciclo que a tela faz entre a gravação e a
leitura agora tem prova automatizada, para que uma regressão na leitura não volte
como campo vazio na tela. Contribuição de @webtecnica (#4437, #2999).
