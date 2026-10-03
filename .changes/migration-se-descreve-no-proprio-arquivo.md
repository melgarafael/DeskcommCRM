---
impacto: nada_mudou
secao: alterado
titulo: Migration nova se descreve no próprio arquivo e para de conflitar com as outras
---

A descrição de migration nova sai do `supabase/migrations/MANIFEST.md` e passa para uma linha `-- manifest: <o quê e por quê>` no cabeçalho do próprio `.sql`. Todo PR com migration acrescentava uma linha no fim da mesma tabela, e o GitHub ignora o `merge=union` que resolvia isso no git local: cada migration que entrava deixava os outros PRs com migration em conflito. O MANIFEST.md vira histórico, o gate passa a ler as duas fontes e continua reprovando migration sem descrição, número repetido e carimbo repetido. Nada muda para quem opera uma VPS: o kit não lê o MANIFEST.
