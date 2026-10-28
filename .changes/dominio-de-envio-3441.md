---
impacto: capacidade_nova
secao: adicionado
titulo: Conta de e-mail da empresa e conferência do domínio de envio
---

Em **Configurações → Marca**, a empresa pode conectar sua conta Resend com um endereço do domínio verificado. A chave fica cifrada e não é mostrada de volta. As automações usam essa conta; sem uma conta conectada, continuam usando o envio da instalação. Convites, recuperação de senha e e-mails de dados pessoais continuam pelo remetente do sistema. Uma conta ilegível ou indisponível é sinalizada como falha, sem trocar silenciosamente o remetente.

O card **Domínio de envio** consulta os registros esperados pela conta conectada e compara com o DNS, incluindo Return-Path personalizado e CNAME. O estado informado pela Resend fica separado das pendências do DNS. Falha na consulta não aparece como registro ausente, e a conferência não promete entrega na caixa de entrada.

Contribuição de @webtecnica (#3443 e #3464). Refs #3287 e #3441; campanhas, supressão e descadastro permanecem em suas próprias entregas.
