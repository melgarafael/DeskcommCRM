---
impacto: nada_mudou
secao: corrigido
titulo: E-mail de recuperação de senha volta a sair no single-server atrás de um Traefik externo
---

Na instalação single-server (Supabase na mesma VPS) atrás de um Traefik da hospedagem, o "esqueci minha senha" e a confirmação de cadastro não enviavam e-mail: o serviço de autenticação buscava o modelo do e-mail no app pelo domínio público, essa busca saía pelo IP da própria VPS e dava timeout, porque o Traefik externo não devolve a conexão para dentro da máquina. Agora o serviço de autenticação entra na rede privada do app e busca o modelo direto nela (`http://app:3000/email-templates/...`), sem passar pelo domínio.

Você não precisa fazer nada: o `update.sh` liga o serviço de autenticação à rede privada e troca o endereço que o próprio kit tinha gravado (`https://SEU_DOMINIO/email-templates/...`) pelo interno. Um modelo que você tenha apontado para outro lugar continua como está. Instalações com o Supabase na nuvem ou com um Supabase próprio fora do kit não mudam.

Crédito: @daviguerreiroa.
