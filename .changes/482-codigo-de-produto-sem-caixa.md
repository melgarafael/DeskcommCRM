---
impacto: nada_mudou
secao: corrigido
titulo: A planilha de produtos trata IP15 e ip15 como o mesmo código
---

Na importação de produtos por planilha, um código que só difere de outro nas maiúsculas e minúsculas ("IP15" e "ip15") passa a ser tratado como o mesmo código em todo o caminho. Antes, a planilha recusava a segunda grafia quando as duas vinham no mesmo arquivo, mas aceitava "ip15" quando "IP15" já estava no catálogo, e criava um segundo produto. Como a busca que o agente usa para responder o cliente não diferencia maiúsculas, esse segundo produto podia fazer o agente citar dois preços para o mesmo item.

Agora as duas situações são recusadas, com o motivo no resumo da importação. Dentro do mesmo arquivo, a linha repetida diz com qual linha colide e como o código estava escrito lá. Contra o catálogo, a linha diz como o código já está cadastrado; para atualizar esse produto, basta escrever o código igual ao do catálogo. As outras linhas da planilha entram normalmente.

Nada para fazer. Quem já tem no catálogo dois produtos que só diferem na caixa continua com os dois: a importação não apaga nem junta nada, só deixa de criar novos casos.

Diagnóstico de @webtecnica na issue #482 e no #1441.
