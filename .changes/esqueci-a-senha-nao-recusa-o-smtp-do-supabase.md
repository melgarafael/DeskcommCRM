---
impacto: nada_mudou
secao: corrigido
titulo: A tela de "esqueci a senha" deixa de recusar a recuperação quando o SMTP está só no .env do Supabase
---
Numa instalação de servidor único com o SMTP configurado direto no arquivo de ambiente do Supabase — e nada em /admin/email —, a tela de "esqueci a senha" recusava a recuperação antes de perguntar ao serviço de login: o e-mail sairia, e a pessoa ouvia que "sem SMTP configurado não sai e-mail nenhum", sem ter o que fazer. Agora quem decide é a resposta do próprio serviço de login: se ele envia, a recuperação segue normalmente; ele só responde "sem SMTP" quando não conseguiu enviar, e aí a frase diz o que aconteceu, apontando /admin/email para o administrador.

Contribuição de @webtecnica (#3188).
