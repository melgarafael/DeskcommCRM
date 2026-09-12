---
impacto: exige_acao
secao: alterado
titulo: E-mail transacional agora usa SMTP configurável
---

Convites de equipe, entregas de LGPD e alertas de SLA deixam de depender de uma
chave de provedor específico. Configure seu servidor em Configurações → E-mail
e convites ou no `.env` com `SMTP_HOST`, `SMTP_PORT`,
`SMTP_SECURITY`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL` e
`SMTP_FROM_NAME`.

Para servidores com SSL/TLS implícito, use porta **465** e segurança `tls`.
Para STARTTLS, use porta **587** e `starttls`. Após atualizar, substitua as
variáveis antigas de e-mail por essa configuração antes de reenviar convites.

## Requer atenção

Se você já usava o envio de e-mail, cadastre o SMTP completo em Configurações →
E-mail e convites ou atualize o `.env` antes de reenviar convites ou exports.
