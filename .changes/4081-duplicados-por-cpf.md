---
impacto: capacidade_nova
secao: adicionado
titulo: Duplicados reconhece duas fichas com o mesmo CPF
---

A tela "Juntar duplicados" agrupava quem tem o mesmo telefone ou o mesmo e-mail,
mais o telefone que a ingestão do WhatsApp deixa em conflito. O CPF não entrava
em cruzamento nenhum: a rota nem lia `cpf_hash`, e no clone onde o índice
`uniq_contacts_org_cpf` não nasceu — ele é criado com `if not exists` e o
`update.sh` roda sem `ON_ERROR_STOP` — duas fichas vivas com o mesmo documento
seguiam separadas para sempre.

Agora `cpf_hash` igual e não vazio une o par com o motivo "mesmo CPF", encadeia
com os outros motivos — A e B pelo CPF, B e C pelo telefone dá **um grupo só** —
e conta como motivo forte, então "Não são a mesma empresa" recusa dispensar um
par ligado por CPF. O hash é lido para comparar e não é devolvido na resposta da
tela. A sugestão pelo nome ("Parecidos — confira") segue como estava.

Crédito: @webtecnica (#4104, issue #4081 de @hudson-souza-mkt).
