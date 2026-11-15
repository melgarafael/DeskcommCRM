---
impacto: capacidade_nova
secao: adicionado
titulo: Equipe pode criar uma pessoa com senha, sem depender de convite por e-mail
---

Na tela de Equipe, quem administra ganhou "Criar usuário com senha": nome,
e-mail, papel e uma senha provisória. A conta já nasce pronta e confirmada —
**nenhum e-mail é enviado**, então o caminho funciona em instalação sem SMTP e
sem caixa postal.

A pessoa entra com a senha provisória e é obrigada a escolher uma senha própria
no primeiro acesso. Enquanto não trocar, o servidor recusa as rotas de API e a
tela a leva para a troca; a régua de senha é a mesma da recuperação de senha
(mínimo de 8 caracteres, com letra, número e símbolo).

O convite continua igual: quem entra por link de convite **não** passa pela
troca obrigatória, e o e-mail que já tem conta não é aceito nesta porta nova.
