---
impacto: capacidade_nova
secao: adicionado
titulo: "O aviso de aniversário pode sair N dias antes da data"
---

A automação `No aniversário de um contato` ganhou o campo **Dias de antecedência** (0 a 365). Com 10, o aviso sai dez dias antes da data de nascimento, às 9h no fuso da sua empresa — tempo para a cliente marcar o horário do mês do aniversário. A conta é de calendário: quem faz aniversário em 05/01 recebe em 26/12, e quem nasceu em 29/02 é avisado contando o dia 28 em ano não bissexto.

Nada muda no que já está configurado: toda automação de aniversário existente vale com 0 e continua avisando no próprio dia. Cada contato recebe um aviso por ano em cada automação, e duas automações com antecedências diferentes (uma 10 dias antes, outra no dia) funcionam juntas, cada uma no seu dia.

Crédito: @webtecnica.
