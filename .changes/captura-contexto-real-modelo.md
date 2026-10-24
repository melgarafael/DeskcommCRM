---
titulo: Preservar o contexto efetivamente enviado no diagnóstico privado
impacto: nada_mudou
secao: corrigido
---

O diagnóstico privado passa a solicitar ao SDK o corpo e as mensagens de cada
passo do agente e dos revisores nativos somente durante a coleta autorizada.
Textos longos do contexto são sanitizados antes de serem divididos em segmentos
limitados, com cobertura e omissões explícitas. Permanecem os limites de acesso,
expiração e quota; a coleta continua desligada por padrão e não interfere no envio.
