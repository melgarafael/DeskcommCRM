# E-mail pelo Brevo

O transporte existente em `lib/email/resend.ts` atende os convites de equipe e
onboarding e as notificações LGPD. Configure `BREVO_API_KEY` e
`BREVO_FROM_EMAIL` no `.env` do servidor. Não coloque credenciais no frontend.
Quando a chave Brevo está presente, o remetente Brevo também é obrigatório;
não há fallback para Resend após erro, pois isso pode duplicar uma entrega.
Sem chave Brevo, o transporte Resend existente continua sendo usado.

Cadastro e recuperação de senha saem pelo Supabase Auth. Na instalação
self-host, configure o SMTP do GoTrue com `smtp-relay.brevo.com`, porta `587`,
login SMTP exibido pelo Brevo e **chave SMTP**, que é diferente da chave API.
Use um remetente autenticado. Recrie apenas o serviço Auth e confirme sua
saúde antes de testar a recuperação pela página pública.

Guarde a configuração anterior com permissão restrita para rollback. Após
atualizar o app, teste um convite autorizado e consulte o evento `delivered`
no Brevo. HTTP 201 / `messageId` comprovam aceite, não entrega na caixa postal.
Os chamadores preservam a auditoria existente e mostram o link de convite
quando o envio falha; nenhuma fila antiga é reenviada automaticamente.

Verificação: `tests/unit/email-brevo.test.ts` cobre payload, ausência de
configuração, recusa, limite, timeout, resposta incompleta e compatibilidade
com Resend. Não altera tabelas, regras de acesso ou a jornada de cadastro.
