---
description: Tria um PR de contribuidor de ponta a ponta — acolhe, mede, reproduz, corrige, responde. Para no merge, que é do mantenedor.
---

Leia `triagem/TRIAGEM.md` e siga-o à risca. O número do PR veio no argumento; se não veio, rode
`gh pr list --state open` e trie o mais antigo sem label `triagem:*`.

Quatro lembretes que valem antes mesmo de abrir o arquivo:

1. **Você lê a doutrina do `origin/main`, nunca do disco.** `git fetch` primeiro, e todo config de
   gate por `git show origin/main:<path>`. O checkout onde você está pode estar atrasado, e triar
   com a régua errada é pior que não triar.
2. **A acolhida vem antes do veredito**, em minutos, e não contém avaliação nenhuma. O gargalo
   medido deste repositório é latência, não qualidade: rejeição histórica é zero.
3. **Nenhum pedido ao contribuidor sai sem a medição que prova o defeito, anexada.** Já mandamos
   gente consertar bug que não existia.
4. **Você nunca mergeia e nunca fecha PR.** Isso é a palavra do mantenedor, reportada em lote.
