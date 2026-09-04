---
impacto: nada_mudou
secao: corrigido
titulo: Anonimizar um contato retoma de onde parou, em vez de dizer que já foi
---

A anonimização de um contato remove os dados pessoais em três lugares: o
cadastro do contato, os títulos dos negócios dele e o histórico de atividades.
Se a operação era interrompida no meio — o navegador desistindo, o servidor
reiniciando —, o primeiro lugar ficava pronto e os outros dois não.

E não havia como terminar: clicar em "Anonimizar" de novo respondia **"já anonimizado"**
e não fazia mais nada. O contato ficava para sempre com nome de
cliente visível dentro dos negócios e do histórico — que é exatamente o dado que
a anonimização existe para remover, e que a lei dá prazo para remover.

Pior: nesse estado a tela **não mostra botão nenhum** — assim que o contato
consta como anonimizado, o botão dá lugar a um aviso. Não havia como pedir a
retomada nem sabendo que ela era necessária.

Agora a verificação diária do sistema encontra sozinha as anonimizações que
ficaram pela metade e termina o serviço, sem ninguém precisar procurar contato
por contato. Como a lei dá prazo, esse conserto não podia depender de alguém
lembrar de clicar. Rodar de novo num contato já inteiro não escreve nada, e o
registro de auditoria mostra o que foi realmente feito, em qual contato e em que
dia — separado da execução original, para a data em que o titular exerceu o
direito não ser sobrescrita.
