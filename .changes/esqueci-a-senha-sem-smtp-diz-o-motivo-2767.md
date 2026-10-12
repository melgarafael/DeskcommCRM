---
impacto: nada_mudou
secao: corrigido
titulo: Sem SMTP, o "esqueci a senha" diz o motivo em vez de mandar tentar de novo
---

Numa instalação de servidor único sem SMTP configurado, o "esqueci a senha" respondia "Não foi possível enviar o e-mail. Tente novamente.", e tentar de novo nunca funcionaria. Agora a tela diz que a recuperação de senha não está disponível nesta instalação porque não há SMTP, e que o administrador configura em /admin/email. O aviso do `update.sh` para o mesmo caso passa a dizer por que é preciso rodá-lo de novo depois de configurar: é ele que leva o SMTP do CRM ao serviço de login. Com SMTP configurado, ou com o Supabase na nuvem, nada muda.

Um limite: quem pôs o SMTP direto no `.env` do Supabase, sem passar por /admin/email, passa a ver a mensagem de "sem SMTP". Configure o mesmo servidor em /admin/email e rode o `update.sh`.

Contribuição de @webtecnica (#2767), a partir da issue #2755.
