---
impacto: nada_mudou
secao: corrigido
titulo: A Central de avisos não diz mais "nenhum aviso em aberto" a quem não alcança a Central
---
Quem tem papel de acompanhamento (somente leitura) abria a Central de avisos e lia "Nenhum aviso em aberto", mesmo existindo avisos abertos que aquele papel não pode ver. A Central exige atendimento, e a API sempre recusou essa leitura — o que enganava era o texto. Agora quem não alcança a Central lê que ela é de quem atende e que os avisos são pedidos do assistente para essas pessoas, com o caminho para revisar o acesso. Quem atende continua vendo a lista e o estado vazio como antes. Nada a fazer na atualização.

Contribuição de @webtecnica (#3159).
