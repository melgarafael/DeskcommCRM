---
impacto: nada_mudou
secao: corrigido
titulo: Os erros do navegador voltam a chegar ao Sentry
---

O envio de erros da tela para o Sentry passa pelo caminho `/monitoring` do próprio app, e esse caminho era redirecionado para o `/login`, com ou sem sessão. Nenhum erro de navegador chegava ao Sentry, nem os da tela de login e de cadastro. Agora o envio segue direto. Contribuição de @AyhamJo7, a partir da issue #5091.
