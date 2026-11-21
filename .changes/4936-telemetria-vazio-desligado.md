---
impacto: exige_acao
secao: alterado
titulo: SENTRY_DSN vazio deixa de ligar o Sentry do projeto; o aceite passa a ser o token comunidade
---

`SENTRY_DSN` vazio (ou ausente) passou a significar telemetria DESLIGADA. Quem aceita o Sentry do projeto escreve `SENTRY_DSN=comunidade`, e é esse token que o `install.sh` grava quando a pessoa responde "sim" — a chave do ingest não vai para o `.env` de quem instala. O instalador da VM local passou a perguntar em vez de gravar vazio, e o `update.sh` converte sozinho o `SENTRY_DSN=""` de quem já havia aceitado, sem edição manual do arquivo.

## Requer atenção

Quem já havia aceitado a telemetria tem `SENTRY_DSN=""` no `.env`, e vazio agora desliga. Rodar o `update.sh` (uma vez, como de costume) converte a chave para `SENTRY_DSN=comunidade` e o envio continua; quem não roda nada simplesmente para de enviar. Não descomente a linha da telemetria no `.env.hostgator.example`: chave vazia deixou de ser consentimento.
