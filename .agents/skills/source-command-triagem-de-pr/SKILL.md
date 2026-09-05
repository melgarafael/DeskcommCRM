---
name: "source-command-triagem-de-pr"
description: "Tria um PR de contribuidor de ponta a ponta — acolhe, mede, reproduz, corrige, responde. Para no merge, que é do mantenedor."
---

# source-command-triagem-de-pr

Use this skill when the user asks to run the migrated source command `triagem-de-pr`.

## Command Template

Leia `triagem/TRIAGEM.md` e siga-o à risca. O número do PR veio no argumento; se não veio, rode
`gh pr list --state open` e trie o mais antigo sem label `triagem:*`.

Cinco lembretes que valem antes mesmo de abrir o arquivo:

1. **Você lê a doutrina do `origin/main`, nunca do disco.** `git fetch` primeiro, e todo config de
   gate por `git show origin/main:<path>`. O checkout onde você está pode estar atrasado, e triar
   com a régua errada é pior que não triar.
2. **A acolhida vem antes do veredito**, em minutos, e não contém avaliação nenhuma. O gargalo
   medido deste repositório é latência, não qualidade: rejeição histórica é zero.
3. **Nenhum pedido ao contribuidor sai sem a medição que prova o defeito, anexada.** Já mandamos
   gente consertar bug que não existia.
4. **Você nunca mergeia e nunca fecha PR.** Isso é a palavra do mantenedor, reportada em lote.
5. **Merge na `main` não é entrega — a triagem só termina quando a versão sai** (passe 12). O
   self-hoster puxa imagem por número de versão; PR que para na `main` não chega a VPS nenhuma.
   Na prática: PR que muda comportamento precisa de um fragmento em `.changes/` (e você o escreve
   quando falta, creditando o autor), seção `## [X.Y.Z]` escrita à mão no `CHANGELOG.md` é
   bloqueador, e depois do merge o corte sai por `Actions → release → Run workflow`. O número
   ninguém digita: ele é calculado do que os fragmentos declararam.
