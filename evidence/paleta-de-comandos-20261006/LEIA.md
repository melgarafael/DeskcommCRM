# A paleta de comandos (⌘K) volta a caber na tela

Prova pela tela (DoD 12) do conserto de posicionamento da busca rápida.

## O defeito, e de onde ele veio

A paleta encostava no alto da janela e saía cortada. A causa não estava nela:
estava na animação de entrada dos sobrepostos que esta mesma linha de trabalho
acrescentou ao promover os keyframes do showcase.

`@keyframes ds-modal-entra` terminava em `translate: -50% -50%` — o
deslocamento que centraliza um diálogo comum. Com `animation-fill-mode: both`, o
valor final de uma animação **continua valendo depois que ela termina**, e por
isso passava por cima do `translate-y-0` da paleta, que abria presa ao topo com
`top-[10%]`. Resultado: ela era puxada meia altura para cima do próprio ponto de
ancoragem.

Antes deste ciclo o defeito não existia porque as classes de animação estavam
**mortas** — `tailwindcss-animate` não está instalado, e `animate-in` /
`slide-in-from-top-[48%]` não geravam CSS nenhum. Ressuscitá-las acendeu o
conflito que estava latente.

## O conserto, nas duas pontas

1. A paleta abre **centralizada**, e a sobra de altura se reparte nas duas
   pontas. O teto do `DialogContent` (`max-h-[calc(100dvh-2rem)]`) resolve lista
   longa com rolagem interna.
2. Os keyframes passaram a ler `--ds-modal-x` / `--ds-modal-y`, com `-50%` de
   padrão. Quem ancorar diferente declara a variável e a animação acompanha —
   em vez de impor a própria posição e quebrar em silêncio.

## Medido, não olhado

![A paleta de comandos aberta e centralizada na janela](evidence/paleta-de-comandos-20261006/paleta-centralizada.png)

`getBoundingClientRect()` numa janela de 900px de altura:

```
topo: 115px · base: 785px · folga em cima: 115px · folga embaixo: 115px
```

Simétrica — que é a definição de centralizada, e o que a captura mostra.
