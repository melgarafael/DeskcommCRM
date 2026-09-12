# Doutrina da Ação Destrutiva

> Lei sobre o **clique que apaga**: toda ação que destrói trabalho na tela pede confirmação, e a
> confirmação diz **o que vai embora**. Complementa `docs/doctrine/versionamento.md` (o número que
> a mudança produz) tratando do que a mudança **faz com o trabalho de quem está na tela**.

## O princípio-raiz

A pergunta não é *"esta ação é perigosa?"* — quem escreveu o código responde "não" para o próprio
botão. A pergunta é:

> **"Se este clique estiver errado, o que o operador perde?"**

Se a resposta inclui trabalho que ele não refaz de memória — um canvas montado à mão durante
meia hora, um fluxo com versões publicadas —, o clique não pode ser o primeiro. Não é sobre
medo do usuário: é que o custo do erro é assimétrico. Confirmar custa um segundo; perder o
canvas custa o turno.

## O caso que originou a regra (issue #700)

No builder de follow-up, o botão de excluir a **seleção** (nó ou aresta) e o botão de excluir o
**fluxo inteiro** dividem o mesmo assento da barra: mesmo ícone de lixeira, mesma cor destrutiva,
mesmo tamanho, a poucos pixels de distância — em
`app/app/ai/followups/[id]/_components/PublishBar.tsx`.

Só um dos dois pedia confirmação. O arranjo resultante é o pior possível entre dois irmãos: o
botão mais à mão (o que existe para limpar o que o operador acabou de selecionar) disparava a
exclusão no primeiro clique, enquanto o vizinho — o ícone idêntico que apaga o fluxo e, com ele,
versões e inscrições — perguntava antes. Quem aprendeu a confiar na lixeira daquele canto
confiava com metade da proteção, e o erro custava o trabalho do canvas.

**A assimetria era o defeito.** Não o botão: a ação é legítima e precisa existir. Dois botões
gêmeos no mesmo lugar não podem ter contratos diferentes.

## A régua

| O clique… | Confirmação |
|---|---|
| Não apaga trabalho (salvar, publicar, organizar, alternar seleção) | **Nenhuma** — atrito puro não protege ninguém |
| Apaga trabalho (nó, aresta, fluxo, template, fonte, credencial) | **Obrigatória**, com o **alvo nomeado** no título |
| Apaga em lote ou tira a tela do lugar (ex.: excluir o fluxo aberto) | Obrigatória, dizendo **o que vai junto** e que **não há desfazer** |

O alvo nomeado é metade da regra. "Tem certeza?" não informa nada: quem clicou por engano
confirma de novo pelo mesmo motivo que errou. *"Excluir este nó?"* é uma pergunta que só faz
sentido se era isso mesmo que ele queria — e o erro morre ali.

## Como aplicar

O padrão da casa é o `AlertDialog` de `components/ui/alert-dialog`, o mesmo de
`DeleteFollowupFlowButton`:

1. O botão destrutivo **só abre o diálogo** (`setOpen(true)`) — nunca chama a exclusão.
2. O título nomeia o alvo no vocabulário da tela: *"Excluir este nó?"*, *"Excluir esta aresta?"*.
3. A descrição diz a **consequência** em uma frase: o que é apagado junto e que não há desfazer.
4. Ações: `Cancelar` e a que exclui — **a exclusão acontece no clique de dentro do diálogo**.
5. Quando o alvo varia (nó × aresta), o texto acompanha a seleção; variedade sem texto próprio
   não é confirmação, é ruído.

## Verificação

O contrato do call-site é medido em teste, não em prosa:
`app/app/ai/followups/[id]/_components/PublishBar.test.tsx` fixa que nada é excluído antes da
confirmação, que cancelar não exclui, que confirmar exclui uma vez, e que o diálogo nomeia o
alvo conforme a seleção. Do lado do canvas,
`tests/unit/followup-excluir-no-leva-as-arestas.test.ts` garante que apagar o nó continua levando
as arestas ligadas — a frase que a confirmação promete.

Não há gate de varredura: a regra se cobra na revisão de quem adiciona o próximo botão
destrutivo e nos testes do call-site. Um alerta que só existe para telas já corrigidas não
envelhece melhor que os outros.
