---
impacto: nada_mudou
secao: corrigido
titulo: Teste da recuperação de faltas deixa de depender da lentidão das telas
---

O teste de ponta a ponta que confere a recuperação de faltas da agenda (envio
inline, retomada pelo executor e proteção de agenda além de mil compromissos)
passou a falhar depois que as telas ficaram mais rápidas com o cache curto da
autorização: o terceiro envio do mesmo número caía dentro do intervalo
anti-banimento e era adiado, então a corrida que o teste mede nunca acontecia.
O número de teste agora declara intervalo zero, como os demais testes que não
medem o ritmo. Nada muda no produto nem na VPS.
