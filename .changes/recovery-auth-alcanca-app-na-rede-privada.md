---
impacto: nada_mudou
secao: corrigido
titulo: Recuperação de senha funciona no Supabase próprio com proxy externo
---

Em instalações single-server que usam Traefik externo, o serviço de autenticação passa a buscar os modelos de recuperação e confirmação pela rede privada do app. Isso evita o timeout no endereço público da instalação e mantém o envio de e-mail pelo SMTP configurado em Admin → E-mail.
