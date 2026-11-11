---
impacto: nada_mudou
secao: corrigido
titulo: A busca do funil e a de contatos passam a achar o nome mesmo quando o acento está só de um lado
---

A busca do funil comparava o texto digitado com o do negócio em minúsculas, e acento é outra letra para essa comparação: quem digitava "Andreia" não achava o negócio da "Andréia" — e o contrário também não. As outras portas de busca de contato (a tela de Contatos, o seletor do negócio e a ferramenta do agente) já achavam os nomes em português, mas por uma régua própria, limitada às letras da língua: "Pena" não achava "Peña" e havia duas regras de acento convivendo no produto.

As duas passam a usar a mesma régua de acento da busca da Inbox, e a comparação normaliza os dois lados: **quem digita com acento também acha o nome cadastrado sem acento**. No funil, o filtro é feito na tela sobre os negócios já carregados, então a normalização vale para o termo e para o texto do card; nas portas de contato, a busca usa a coluna normalizada do banco, a mesma que a Inbox já usava. Caixa (maiúscula e minúscula), cedilha, hífen e apóstrofo continuam funcionando, a busca por telefone e por e-mail segue igual, o recorte por organização não muda e um termo sem relação continua devolvendo lista vazia. Nenhuma configuração muda. Contribuição de @webtecnica (#3918).
