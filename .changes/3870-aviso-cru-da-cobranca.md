---
impacto: nada_mudou
secao: corrigido
titulo: O aviso de cobrança recusado diz o motivo, e a falha ao identificar a empresa deixa rastro
---

A linha de recusa do arquivo de avisos (`webhook_events_log`) dizia sempre
`assinatura_invalida`, mesmo quando o corpo chegava vazio ou não era JSON. Agora
ela diz `corpo_vazio` ou `corpo_malformado` nesses casos, sem guardar o corpo.

Quando a leitura da empresa do cliente falhava, a rota devolvia 500 sem gravar
nada, e o aviso ia embora sem rastro. Agora o ponteiro (`{id,type}`) fica gravado
com o motivo, o erro vai ao log e a linha é fechada quando o provedor reentrega.
No Asaas, acima do limite de avisos sem empresa identificada, a resposta é 200
sem gravar, e a reconciliação cura.

O corpo e os cabeçalhos do aviso continuam fora do arquivo, como aprovado na
especificação da cobrança: quem decide é a releitura no provedor.
