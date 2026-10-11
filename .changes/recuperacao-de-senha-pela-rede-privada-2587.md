---
impacto: nada_mudou
secao: corrigido
titulo: E-mails de recuperação de senha e de confirmação voltam a usar o modelo da instalação no single-server atrás de um proxy externo
---

Na instalação single-server (Supabase na mesma VPS) atrás de um Traefik da hospedagem, os e-mails de "esqueci minha senha" e de confirmação de cadastro podiam sair no modelo padrão do Supabase, em inglês, cujo link não fecha a sessão quando o clique vem do webmail. O serviço de autenticação buscava o modelo no app pelo domínio público, e de dentro dos contêineres o domínio não respondia nessa VPS. Agora o serviço de autenticação entra na rede privada do app e busca o modelo direto nela (`http://app:3000/email-templates/...`), sem passar pelo domínio.

Você não precisa fazer nada: o `update.sh` liga o serviço de autenticação à rede privada e troca o endereço que o próprio kit tinha gravado (`https://SEU_DOMINIO/email-templates/...`) pelo interno. Um modelo que você tenha apontado para outro lugar continua como está. Instalações com o Supabase na nuvem ou com um Supabase próprio fora do kit não mudam.

Crédito: @daviguerreiroa.
