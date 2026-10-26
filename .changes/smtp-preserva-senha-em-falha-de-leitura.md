---
impacto: nada_mudou
secao: corrigido
titulo: Uma falha ao ler a configuração de e-mail preserva a senha já gravada
---

Se o banco não responder ao consultar a senha SMTP existente, salvar a
configuração informa a falha e preserva o que já estava gravado. Uma tentativa
incompleta não substitui a senha por um valor vazio. Crédito:
@emersonalex2026-svg, PR #3445.
