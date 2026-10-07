---
impacto: nada_mudou
secao: corrigido
titulo: Ajustar o invariante que a própria branch criou deixa de pedir a válvula
---

A catraca de `tests/invariants/` barrava qualquer modificação contra o último commit, e isso incluía o invariante que a própria branch tinha acabado de criar e que a `main` nunca viu. A única saída era a válvula `DESKCOMM_GOV_INVARIANTS_EDIT=1`, reservada ao flip de `test.fails`, e ela já tinha sido usada duas vezes só por isso, na triagem de PRs de contribuidor. Uma válvula que vira rotina deixa de proteger.

Agora uma modificação passa sem válvula quando o caminho não existe em `origin/main` nem no ponto de onde a branch saiu dela, e quando foi um commit próprio da branch (não um merge) que o adicionou. Para a `main` isso é um arquivo novo. Invariante da `main` editado, apagado, renomeado ou revertido continua barrado, inclusive o que chegou à branch por merge de uma `main` mais nova que a ref local, e sem a ref `origin/main` a guarda falha fechada como antes. O cabeçalho do hook registra os dois limites que sobram com a ref local desatualizada (rebase sobre uma `main` cujo invariante entrou por commit direto, e o invariante da própria branch que já entrou na `main`). Rodar `git fetch` antes de trabalhar fecha os dois.

Não exige ação de ninguém.
