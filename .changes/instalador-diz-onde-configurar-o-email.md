---
impacto: nada_mudou
secao: corrigido
titulo: O instalador diz onde configurar o envio de e-mail ao pular a Resend
---

Quem deixava a chave da Resend em branco na entrevista terminava sem saber que o envio tinha caminho de volta: o `.env` saía sem remetente, e o CRM subia sem mandar convite de equipe, PDF de LGPD nem — em Supabase próprio — os e-mails de acesso (senha, cadastro). Agora o campo da Resend mostra o atalho junto do "Enter pula", e a tela final — a única que a pessoa lê inteira — repete a pendência dizendo o que não sai e onde ligar: Admin → E-mail, a mesma tela que configura o servidor SMTP próprio ou o serviço externo (Resend). Num Supabase próprio o aviso acrescenta o passo `bash hostgator-setup-kit/update.sh`, para o GoTrue passar a usar o mesmo servidor.

Nenhuma ação para quem já manda e-mail: o aviso só aparece quando não há `RESEND_API_KEY` nem `SMTP_HOST` no `.env`.
