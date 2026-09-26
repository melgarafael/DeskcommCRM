---
impacto: capacidade_nova
secao: alterado
titulo: Telemetria atualizada para o Sentry 11, com a coleta de dados pessoais travada no mínimo
---

O componente que envia relatórios de erro foi atualizado para a versão 11 do
Sentry. A versão nova passaria a coletar, por padrão, IP, cookies, corpo das
requisições e o texto trocado com a IA. Aqui essa coleta continua desligada, de
forma explícita, e a limpeza de dados pessoais (e-mail, CPF, telefone, IP,
tokens de webhook e de convite) agora é conferida no pacote que de fato sai do
servidor. Quem usa o padrão (Sentry da comunidade) ou desligou a telemetria
(`SENTRY_DSN=off`) não precisa fazer nada.

Se você aponta `SENTRY_DSN` para o seu próprio Sentry, o rastreamento de
desempenho passa a ser enviado em fluxo contínuo, sem o antigo limite de 1.000
trechos por requisição. Alguns atributos mudaram de nome (por exemplo,
`http.method` virou `http.request.method` e `db.statement` virou
`db.query.text`), então alertas e painéis que filtram pelos nomes antigos
precisam ser revistos. Se o seu Sentry é auto-hospedado, o SDK novo só dá
suporte à versão 26.4.2 ou mais nova. Os relatórios de erro continuam chegando
como antes.
