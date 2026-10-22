---
impacto: nada_mudou
secao: corrigido
titulo: Na instalação com o Supabase na mesma VPS, os e-mails de acesso chegam com assunto em português
---

Na instalação em que o Supabase roda na própria VPS (`install-single-server.sh`), os e-mails de confirmar a conta e
de redefinir a senha chegavam com o corpo em português e o assunto em inglês (« Confirm Your Signup », « Reset Your
Password »): o assunto é uma configuração do serviço de autenticação, separada do modelo, e ninguém a gravava. Agora
o assunto é « Confirme seu e-mail » e « Redefinir sua senha ». Quem já instalou recebe na próxima atualização; um
assunto que você já escreveu no `.env` do Supabase continua valendo.
