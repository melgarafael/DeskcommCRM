# Celular quase nativo — evidência de 05/10/2026

Prova pela tela (DoD 12) da entrega que implementou os princípios de
[`docs/design-system/screen-flow/07-responsive-strategy.md`](../../docs/design-system/screen-flow/07-responsive-strategy.md)
e a linguagem de movimento de
[`docs/design-system/07-motion-language.md`](../../docs/design-system/07-motion-language.md).

Capturas dirigidas por browser (Chromium, `hasTouch`, `isMobile`), com login de
conta real **e a verificação em duas etapas concluída**, no build de produção
(`next build` + `next start`). A cerca que impede a regressão é
[`tests/e2e/celular-cabe-na-tela.spec.ts`](../../tests/e2e/celular-cabe-na-tela.spec.ts).

## ⚠️ Duas correções de método, antes dos números

**A primeira rodada mediu tela VAZIA, e por um tempo eu reportei aquilo.** A
conta de teste tem verificação em duas etapas. Parando em `/login/mfa`, a sessão
fica meio autenticada: a casca desenha (barra de cima, barra de abas, título) e
toda busca de dado volta 403. As telas pareciam carregadas e estavam ocas — o
painel "sem controles curtos" não tinha controle nenhum, e a contagem saía
subestimada em toda tela que depende de lista. Os números abaixo são de uma
sessão completa; o console fecha em **zero erros**.

**A régua passou de CAIXA para ALCANCE.** `getBoundingClientRect()` mede a caixa
do elemento, e onde a área de toque foi expandida por pseudo-elemento
(`.ds-alvo-44`) a caixa continua pequena enquanto o dedo alcança 44px. O teste
honesto é `document.elementFromPoint` a 21px do centro, nas quatro direções: ele
responde pela árvore real, pseudo-elemento incluso. Uma primeira versão aceitava
o ponto caindo no elemento PAI e produziu dois falsos passes — tocar a fila de
abas não aciona a aba. Só o próprio elemento ou um descendente contam.

## Estouro horizontal

**Zero** em todas as combinações medidas — 4 superfícies × 2 larguras, mais 10
telas internas em 360px (contatos, conexões, equipe, configurações, agentes,
atividades, respostas rápidas, tarefas, auditoria, comandas).

Medido com `document.body.scrollWidth - document.documentElement.clientWidth` —
**nunca** `documentElement.scrollWidth`, que o `overflow-x: clip` de `html`/`body`
grampeia no `clientWidth` e faz a conta dar zero com um filho de 3000px. Neste
produto um estouro não produz barra de rolagem: o conteúdo some pela direita.

## Alvos de toque — 44px (Apple HIG, princípio 4 da estratégia)

As quatro superfícies de celular, em 360px, sessão completa:

| superfície | antes             | depois |
| ---------- | ----------------- | ------ |
| Inbox      | 12                | 2      |
| Funis      | 4                 | 2      |
| Agenda     | 43                | 31     |
| Painel     | — (não carregava) | **0**  |

E as dez telas internas, antes e depois dos quatro primitivos:

| tela              | antes | depois |
| ----------------- | ----- | ------ |
| Conexões          | 7     | **1**  |
| Equipe            | 2     | **0**  |
| Atividades        | 3     | **0**  |
| Auditoria         | 4     | **0**  |
| Contatos          | 2     | **0**  |
| Agentes           | 5     | 3      |
| Tarefas           | 5     | 0      |
| Respostas rápidas | 0     | **0**  |
| Comandas          | 0     | **0**  |

O que sobra é deliberado e está escrito no código:

- **Agenda (31)** — as células de meia hora da grade (`230×24`). A densidade é
  decisão registrada em `components/agenda/GradeDaAgenda.tsx`: "sete colunas em
  360px dão ~44px cada, e a célula de meia hora vira um alvo de ~44x24".
- **Funis (2)** — links de TEXTO dentro de lista (`246×21`, `151×14`). A régua de
  44px é para controle, não para texto.
- **Inbox (2)** — `Fila` (`35×44`) e o caret de próxima aba (`16×44`). Os dois já
  têm os 44px de ALTURA; falta largura, e em controle adjacente numa fila o erro
  recuperável é acertar o vizinho.

## As telas

### 360px — o piso da faixa `mobile` declarada na estratégia (360–767)

![Inbox em 360px: busca e chips com 44px, fila de abas rolável com indicador, e a barra de abas no rodapé com "Inbox" aceso](evidence/celular-quase-nativo-20261005/360-inbox.png)

![Funis em 360px: a barra de abas do rodapé com "Funis" aceso e ícone preenchido, conteúdo terminando acima dela](evidence/celular-quase-nativo-20261005/360-funis.png)

![Agenda em 360px: cartão do Google empilhado, data em duas linhas sem corte, avatares separados, abas do histórico em uma linha, e o aviso no rodapé em vez de cobrir a barra de cima](evidence/celular-quase-nativo-20261005/360-agenda.png)

![Painel em 360px: o estado de erro com ícone, explicação e "Tentar de novo", no lugar da frase vermelha solta](evidence/celular-quase-nativo-20261005/360-painel.png)

### 390px — iPhone 12/13/14, a largura que as outras ~20 specs do repo usam

![Inbox em 390px](evidence/celular-quase-nativo-20261005/390-inbox.png)

![Funis em 390px](evidence/celular-quase-nativo-20261005/390-funis.png)

![Agenda em 390px](evidence/celular-quase-nativo-20261005/390-agenda.png)

![Painel em 390px](evidence/celular-quase-nativo-20261005/390-painel.png)

## O contrato do rodapé, medido na tela

A barra de abas é peça fixa e declara o que ocupa
(`lib/ui/rodape-ocupado.tsx`). Medido no browser, em 390px:

```
altura 54px · folga até o fundo 0px · 5 vagas
--rodape-ocupado: 54px · padding-bottom do <main>: 54px
```

Os dois últimos números batendo são o laço fechado: a peça declarou, a casca
descontou. Sem isso, o fim de toda lista ficaria por baixo das abas — o defeito
da issue #1305 numa peça nova.

No desktop a barra continua no DOM (quem a esconde é `md:hidden`) e a reserva
volta a **zero**, porque ela declara `altura: 0` e deixa a medição decidir —
`getBoundingClientRect()` devolve zero para elemento escondido. Com um piso de
56px ali, o `<main>` do laptop perderia 56px por uma barra que não aparece, e o
Inbox e o quadro do funil encolheriam junto.

## Dois achados que a medição por alcance entregou

**O alvo expandido por pseudo-elemento não basta se o vizinho o cobre.** Os cinco
avatares do filtro de pessoas da agenda mediam 32px e se sobrepunham. Expandir a
área de toque não resolveu: medido por `elementFromPoint`, o ponto a 21px à
direita do centro caía no botão do VIZINHO. O passo entre centros era 38px, e
alvos de 44px nessa distância se invadem. Com `gap-3` o passo fecha em 44 e cada
avatar responde pelo próprio espaço.

**Alvo de toque pode estragar leitura.** Subir as abas do histórico da agenda
para 44px as fez quebrar em três linhas rasgadas dentro do `flex-wrap` do pai —
o dedo melhorou e o olho piorou. A correção foi trocar a quebra por rolagem
horizontal, o mesmo desenho que `components/ui/tabs.tsx` já usava.

## O que esta evidência NÃO prova

Movimento. As animações dos sobrepostos (gaveta, modal, menu, seletor, dica) são
transições, e captura estática não as mostra. O que a captura mostra é o estado
estável depois delas, que é o que a spec mede, de propósito: medir no meio de uma
transição dá falso vermelho hoje e falso verde amanhã.
