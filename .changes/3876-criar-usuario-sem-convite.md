---
impacto: capacidade_nova
secao: adicionado
titulo: Equipe pode criar uma pessoa com senha provisória, sem depender de convite por e-mail
---

Na tela de Equipe apareceu "Criar usuário com senha": nome, e-mail e papel. A
conta já nasce pronta e confirmada, com uma senha provisória gerada pelo sistema
e mostrada uma única vez, logo depois de criar. Nenhum e-mail é enviado, então o
caminho funciona em instalação sem SMTP.

A pessoa entra com a senha provisória e precisa escolher uma senha própria no
primeiro acesso. Até trocar, ela só vê a tela de troca, e o servidor recusa as
rotas de API.

A criação tem limites de segurança. Ela só aparece para o dono da instalação, ou
para o administrador da empresa quando a instalação tem uma empresa só. Numa
instalação com várias empresas, o administrador de empresa continua usando o
convite por e-mail. Há também um limite de tentativas por empresa. O convite
continua igual: quem entra por convite não passa pela troca obrigatória. Nenhuma
ação é necessária na atualização.

Contribuição de @webtecnica (#4120), a partir da issue #3876.
