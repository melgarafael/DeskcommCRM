---
description: Tria um PR de contribuidor de ponta a ponta — acolhe, mede, reproduz, corrige, responde. Para no merge, que é do mantenedor.
---

Leia o `triagem/TRIAGEM.md` **do `origin/main`** e siga-o à risca:

```bash
git fetch origin && git show origin/main:triagem/TRIAGEM.md
```

**E confira que você leu o inteiro, porque cópia velha lê como completa.** Em 08/09/2026 uma sessão
abriu o arquivo do disco: **319 linhas**, terminando direitinho na seção "Modos de falha", sem nada
indicando que faltava alguma coisa — o `origin/main` tinha **1800**. Vinte seções não foram lidas, e
o passe 0-bis foi reinventado do zero. Nenhum sintoma; documento velho não avisa que é velho.

```bash
echo "disco: $(wc -l < triagem/TRIAGEM.md) | main: $(git show origin/main:triagem/TRIAGEM.md | wc -l)"
```

Se os dois números divergirem, **o do disco não existe para esta sessão** — nem para consulta rápida,
nem para "só conferir uma coisa". O mesmo vale para este arquivo de comando.

O número do PR veio no argumento; se não veio, monte a fila com **os dois** comandos abaixo — o
segundo não é opcional, e está explicado no passe 0-bis:

```bash
gh pr list --state open                       # o mais antigo sem label triagem:*
gh pr list --state closed --limit 20 --json number,author,closedAt,mergedAt \
  --jq '.[] | select(.mergedAt == null) | "#\(.number) \(.author.login) \(.closedAt)"'
```

Seis lembretes que valem antes mesmo de abrir o arquivo:

1. **Você lê a doutrina do `origin/main`, nunca do disco — e isso inclui o `TRIAGEM.md`.** `git
   fetch` primeiro, e todo config de gate por `git show origin/main:<path>`. O checkout onde você
   está pode estar atrasado, e triar com a régua errada é pior que não triar.

   Isto já foi cometido **dentro deste próprio passe**: uma sessão leu o `TRIAGEM.md` do disco, numa
   branch de trabalho onde ele tinha 15 KB, enquanto o da `main` tinha 86 KB — e passou a triar sem
   os passes 3-bis, 3-ter, 8-bis e 12-bis, que são exatamente os que essa sessão precisava. O
   arquivo que descreve o modo de falha nº 1 é ele mesmo uma vítima do modo de falha nº 1.
2. **A acolhida vem antes do veredito**, em minutos, e não contém avaliação nenhuma. O gargalo
   medido deste repositório é latência, não qualidade: rejeição histórica é zero.
3. **Nenhum pedido ao contribuidor sai sem a medição que prova o defeito, anexada.** Já mandamos
   gente consertar bug que não existia.
4. **Você nunca mergeia e nunca fecha PR.** Isso é a palavra do mantenedor, reportada em lote.

   Uma exceção, e só ela: quando o próprio mantenedor delega o merge nesta mesma instrução. Aí a
   fronteira do passe 12 se suspende para esta rodada — e não para as seguintes.
5. **Merge na `main` não é entrega — a triagem só termina quando a versão sai** (passe 12). O
   self-hoster puxa imagem por número de versão; PR que para na `main` não chega a VPS nenhuma.
   Na prática: PR que muda comportamento precisa de um fragmento em `.changes/` (e você o escreve
   quando falta, creditando o autor), seção `## [X.Y.Z]` escrita à mão no `CHANGELOG.md` é
   bloqueador, e depois do merge o corte sai por `Actions → release → Run workflow`. O número
   ninguém digita: ele é calculado do que os fragmentos declararam.
