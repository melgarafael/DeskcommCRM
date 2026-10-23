---
impacto: nada_mudou
secao: corrigido
titulo: A instalação atrás de Traefik volta a conferir que a rota do Supabase chegou ao serviço de login
---

Em instalações com proxy reverso Traefik próprio, o fim do instalador volta a confirmar que o caminho público do Supabase (`/auth/v1/*`) chega mesmo ao serviço de login dele, e não ao sistema. A conferência é feita no endereço do seu domínio, com a chave pública do Supabase, e reprova a instalação com uma mensagem clara quando o pedido cai no sistema em vez do serviço de login (o proxy não está encaminhando esse caminho). Antes, nesse caso, a instalação terminava com sucesso e o erro só aparecia na primeira tentativa de entrar. Se a conferência não chegar a uma resposta, por exemplo porque o certificado do domínio ainda está saindo, a instalação mostra um aviso e segue. Nada muda em instalações que já estão no ar, nem nas que usam o proxy padrão. Crédito: @webtecnica.
