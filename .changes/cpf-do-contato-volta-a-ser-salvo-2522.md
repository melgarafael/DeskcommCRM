---
impacto: nada_mudou
secao: corrigido
titulo: Contato com CPF volta a ser salvo, com o CPF cifrado no banco
---

Até aqui, todo contato com CPF era recusado ao ser salvo: o cadastro, a edição e a importação de planilha falhavam na linha inteira, porque a função que cifra o CPF nunca tinha sido criada no banco. Agora o CPF é guardado cifrado, a busca por CPF volta a encontrar o contato, e só gerente ou administrador da empresa consegue ver o número em claro, sempre com registro na auditoria. Se a chave de cifra ainda não estiver no banco, o contato é salvo sem o CPF em vez de ser recusado. Nada precisa ser feito ao atualizar: a atualização cria a função e leva ao banco a chave do CPF que está no seu `.env` (ou gera uma, se ainda não houver). Contribuição de @webtecnica (#2551); o defeito foi relatado e medido por @aerosuiteapp (issue #2522).
