---
impacto: nada_mudou
secao: corrigido
titulo: A busca do seletor de "Inserir variável" acha a variável com ou sem acento
---

Quem digitava no campo de busca do seletor de variável — na mensagem da campanha,
na automação e no follow-up — só achava o item escrevendo acento e grafia
idênticos aos da variável. `saudacao` não aparecia ao digitar « saudação », e
« Nome do contato, como está no cadastro » não aparecia ao digitar « esta ».
Agora a busca usa a mesma regra sem acento do resto do sistema, nos dois
sentidos: digitar com acento acha a variável sem acento, e digitar sem acento
acha a variável e o rótulo acentuados. Contribuição de @webtecnica (#4481).
