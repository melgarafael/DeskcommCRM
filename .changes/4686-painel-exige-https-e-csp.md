---
impacto: nada_mudou
secao: corrigido
titulo: O painel passa a exigir HTTPS e a recusar enquadramento também por CSP
---

O painel já mandava `nosniff`, `X-Frame-Options: DENY`, política de referência e permissões fechadas, mas não mandava `Strict-Transport-Security` nem `Content-Security-Policy` — e o proxy na frente também não manda HSTS, então a primeira visita em `http://` ficava em `http://`, com o cookie de sessão atravessando rede hostil em claro antes de qualquer redirecionamento. Agora toda resposta traz HSTS de um ano e uma CSP curta que recusa enquadramento, troca de base e formulário forjado para fora; `script-src` continua fora da política de propósito, porque o Next injeta bootstrap inline e o app abre WebSocket, e uma política que quebra a tela acaba desligada por quem opera.

Contribuição de @webtecnica (#4686).
