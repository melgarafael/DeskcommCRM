---
impacto: capacidade_nova
secao: corrigido
titulo: Códigos de recuperação passam a funcionar no login, e gerar novos pede o código do aplicativo
---

Os códigos de recuperação passam a funcionar no login quando o celular com o
aplicativo autenticador não está à mão ("Perdi acesso ao autenticador"). O
código pode ser digitado em minúsculas, com espaço ou com hífen. Códigos
gerados antes desta versão não são aceitos: para ter essa saída, quem usa a
verificação em duas etapas precisa gerar códigos novos em Configurações ›
Segurança. Trocar o `INTERNAL_SECRET` da instalação também invalida os códigos
já emitidos.

Em Configurações › Segurança, gerar novos códigos de recuperação agora exige
que a sessão já tenha confirmado o código de 6 dígitos do aplicativo
autenticador — a mesma regra que já valia para desligar a verificação em duas
etapas. Se a sessão ainda não confirmou, a tela leva a pessoa para digitar o
código e depois volta para Segurança.

A mesma regra passa a valer para cadastrar um novo aplicativo autenticador em
uma conta que já tem um. O primeiro cadastro não muda.

Os códigos de recuperação passam a ser lidos e gravados só pelo servidor da
instalação, e o cadastro de um aplicativo autenticador troca o conjunto
anterior de códigos, como já fazia a geração em Segurança. Sem a chave de
serviço configurada, cadastrar a verificação e gerar códigos avisam que não foi
possível, em vez de seguir sem guardar os códigos.
