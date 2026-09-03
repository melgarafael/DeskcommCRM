---
impacto: nada_mudou
secao: corrigido
titulo: A tela de chaves de IA explica o que deu errado e mostra quantos modelos a chave alcança
---

Quem colava uma chave de IA e errava via um código (`auth_failed_401`) no
lugar de uma explicação, e quem acertava via a lista de modelos inteira colada
por vírgula onde deveria haver um número. Se o servidor reiniciasse no meio da
validação, o cartão dizia "Validando…" para sempre.

Agora o cartão diz em português o que aconteceu ("O provedor recusou a chave.
Confira se copiou inteira ou gere uma nova."), com o link para gerar outra;
mostra a contagem de modelos; e, passados dois minutos sem resposta, troca
"Validando…" por "Não validada" com a dica de revalidar. O diálogo de adicionar
passa a dizer quando usar cada provedor, onde a chave mora e como ela começa.
O botão de excluir só fica bloqueado quando a chave está de fato numa versão
publicada de agente — a mesma regra que a API já usava.

Nenhuma configuração nova, nenhum passo de atualização.
