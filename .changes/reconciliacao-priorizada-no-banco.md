---
impacto: nada_mudou
secao: corrigido
titulo: Reconciliação da cobrança escolhe as assinaturas antes do corte da API
---
A rodada de cobrança filtra e ordena as assinaturas no banco antes de receber a lista, respeitando o lote de 50 e a prioridade de quem nunca foi relido. Em instalações com muitas assinaturas, o limite de linhas da API podia esconder quem precisava de reconciliação, deixando um pagamento sem webhook fora da releitura. Crédito: @samirhvbr.
