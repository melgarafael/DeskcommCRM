---
impacto: nada_mudou
secao: corrigido
titulo: Os erros do navegador voltam a chegar ao Sentry
---

O envio de erros da tela para o Sentry passa pelo caminho `/monitoring` do próprio app, e esse caminho era redirecionado para o `/login`, com ou sem sessão. Nenhum erro de navegador chegava ao Sentry, nem os da tela de login e de cadastro. Agora o envio segue direto, e o caminho aceita só o projeto do Sentry configurado nesta instalação, com teto de tamanho e de frequência. Com a telemetria desligada, o caminho não responde. Contribuição de @AyhamJo7, a partir da issue #5091.
