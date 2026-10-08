# 07 — Motion Language

> **Source of truth:** `app/globals.css` (tokens em `:root`, keyframes `ds-*` no
> fim do arquivo). O showcase (`app/design/lib/tokens.ts` → `MOTION`,
> `app/design/showcase.css`) foi a fonte até 05/10/2026, quando o movimento foi
> promovido para o produto — ele segue sendo a vitrine, não o que o cliente roda.

## O que deste documento está EM CÓDIGO

Em 05/10/2026 o produto tinha **uma** animação (`deskcomm-card-pulse`), **uma**
transição (`.agenda-coluna-horarios`) e **~24 classes de animação que não geravam
CSS nenhum** — `animate-in`, `fade-in-0`, `zoom-in-95`, `slide-in-from-*` vêm do
plugin `tailwindcss-animate`, que nunca foi instalado aqui, e classe que o
Tailwind não conhece falha em silêncio. Todo sobreposto do produto abria seco,
com o build verde.

| tipo canônico           | estado                                                                                           | onde                       |
| ----------------------- | ------------------------------------------------------------------------------------------------ | -------------------------- |
| 1. Page transition      | **Não construído, por decisão** — ver abaixo                                                     | —                          |
| 2. Component enter/exit | Construído: `.ds-cortina`, `.ds-gaveta`, `.ds-modal`, `.ds-painel`                               | `app/globals.css`          |
| 3. Hover state          | Parcial: botão tem o recuo de `:active`; o realce de card interativo não foi construído          | `components/ui/button.tsx` |
| 4. Skeleton shimmer     | Construído, com a cor que a casa mediu como legível (a do documento vinha da paleta do showcase) | `.ds-esqueleto`            |

Para reconferir sem acreditar nesta tabela:

```bash
grep -n '^@keyframes' app/globals.css          # o que existe
grep -rn 'animate-in\|slide-in-from' components/ui   # deve voltar vazio
```

**Por que a transição de página não existe.** O gancho idiomático é um
`app/app/template.tsx`, que o Next remonta a cada navegação. Ele acrescenta um
`<div>` entre o `<main>` da casca e a página — e **55 páginas de `app/app/**`
usam `h-full`, `flex-1` ou `min-h-0` na raiz**, contando com o `<main>` como pai
direto. Com o wrapper no meio, `h-full` resolve contra um div de altura
automática: colapso de layout silencioso em toda a área do tenant. Aplicar por
página foi recusado por outro motivo — em `/app/inbox/[id]` a página remonta a
cada CONVERSA aberta, e a "transição de tela" viraria uma piscada por clique.
O caminho para construí-la é tirar o `h-full` da raiz das páginas; é refatoração
de layout, não de movimento.

## Filosofia

Motion no DeskcommCRM **comunica continuidade espacial** — a interface não "aparece", ela "se desloca" da posição anterior pra atual. Não é decoração, não é celebração, não é "modernidade". Cada animação tem propósito; o que não tem, sai.

Quatro testes pra cada animação:

1. **Posso explicar o que essa animação comunica em uma frase?** Se a resposta é "fica bonito", remove.
2. **A duração é proporcional à distância visual?** 8px de translate → 200ms; 100% de slide → 320ms+.
3. **A curva combina com o tipo de movimento?** Entrada suave (`ease-out` sharp), saída firme (`ease-in`), playfulness pontual (`spring`).
4. **Funciona com `prefers-reduced-motion: reduce`?** Sim ou cai pra fade simples.

## 4 tipos canônicos

### 1. Page transition

Quando navegação muda a view inteira (`/inbox` → `/kanban`).

```css
@keyframes ds-page-enter {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.page {
  animation: ds-page-enter 320ms cubic-bezier(0.16, 1, 0.3, 1);
}
```

Curva: `cubic-bezier(0.16, 1, 0.3, 1)` (`motion-slow`). 320ms. Sempre fade + 8px rise (nunca só fade).

### 2. Component enter/exit (modal/sheet)

Modal: scale 0.985 → 1 + translateY(8px) → 0 + fade. 320ms **`ease-out-slow`**.
Sheet: translateX(100%) → 0 + fade backdrop. 320ms **`ease-out-slow`**.

> **Estas duas linhas diziam `ease-spring`, e contradiziam a tabela de curvas
> deste mesmo documento**, que manda `ease-out-slow` em "page enter, modal,
> sheet". A tabela está certa: `ease-spring` é `cubic-bezier(0.34, 1.56, 0.64, 1)`
> e passa de 1 no caminho. Numa gaveta ancorada na borda, essa passagem desenha a
> gaveta ULTRAPASSANDO a borda e voltando — abre uma faixa vazia de alguns pixels
> entre ela e o lado da tela, no meio da entrada. Corrigido em 05/10/2026, junto
> da implementação.

```css
@keyframes ds-modal-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
```

Backdrop entra com fade 200ms ease-base **antes** do conteúdo (5–10ms de offset).

### 3. Hover state

Cards interativos: `translateY(-1px)` + `border-color: accent` + `shadow-sm`. 150–200ms `ease-out`.

```css
.card-interactive {
  transition:
    border-color 120ms cubic-bezier(0.2, 0, 0, 1),
    transform 200ms cubic-bezier(0.16, 1, 0.3, 1),
    box-shadow 200ms cubic-bezier(0.16, 1, 0.3, 1);
}
.card-interactive:hover {
  transform: translateY(-1px);
}
```

Botões: `transform: translateY(1px)` no `:active` (pressed feel), 80ms (instantâneo).

### 4. Skeleton shimmer

Loader visual: linear-gradient atravessa o elemento da direita pra esquerda, infinito.

```css
.skeleton {
  background: linear-gradient(
    90deg,
    var(--ds-surface-elevated) 0%,
    color-mix(in srgb, var(--ds-surface-elevated) 60%, var(--ds-accent-soft)) 50%,
    var(--ds-surface-elevated) 100%
  );
  background-size: 200% 100%;
  animation: ds-shimmer 1.6s linear infinite;
}
@keyframes ds-shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}
```

Duração 1.6s (não 1s — fica frenético; não 2s — fica lento).

---

## Curvas canônicas

| Token           | cubic-bezier            | Onde usar                            |
| --------------- | ----------------------- | ------------------------------------ |
| `ease-out-fast` | `(0.2, 0, 0, 1)`        | Hover, micro-feedback (cor, border)  |
| `ease-base`     | `(0.25, 0.1, 0.25, 1)`  | Default UI (fade, color shift)       |
| `ease-out-slow` | `(0.16, 1, 0.3, 1)`     | Page enter, modal, sheet             |
| `ease-spring`   | `(0.34, 1.56, 0.64, 1)` | Pop, drag confirm, badge celebration |

## Durations

| Token           | Valor | Quando                             |
| --------------- | ----- | ---------------------------------- |
| `motion-fast`   | 120ms | Hover state, color, border         |
| `motion-base`   | 200ms | Fade simples, color shift composto |
| `motion-slow`   | 320ms | Page transition, modal, sheet      |
| `motion-spring` | 420ms | Spring pop (raro)                  |

**Regra:** durações fora dessa tabela são proibidas. Se precisa de 250ms, use 200; de 280, use 320.

---

## Princípios

- **Nunca animar mais de 2 propriedades simultâneas** (excetuando shadow + border, que andam junto). Mais que isso vira ruído.
- **Sempre incluir transform companheiro do fade.** Fade puro (`opacity 0 → 1`) parece flicker; fade + translate(Y/X) parece movimento.
- **Curva combina com origem.** Hover (de fora pra dentro) usa `ease-out`; click (de dentro pra fora) usa `ease-in` — mas raramente animamos saída de click.
- **Stagger é especial.** Lista que entra com cada item atrasado em 50ms é aceitável **uma vez por sessão** (primeiro carregamento). Após scroll/refetch, sem stagger.

---

## `prefers-reduced-motion`

Sempre respeitar. Em vez de remover toda animação, **simplificar pra fade-only com duração reduzida**:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Skeleton shimmer pode manter (não causa motion sickness).

---

## Anti-patterns

❌ **Spring com bounce alto.** `cubic-bezier(0.68, -0.55, 0.27, 1.55)` ou similar. Faz o elemento "pular". Reservar bounce sutil (`1.56`) pra raros casos.

❌ **Parallax decorativo.** Hero scroll com 3 layers se movendo em velocidades diferentes. Não combina com soft-tech.

❌ **Fade-in sem transform companheiro.** Vira flicker em monitor de baixa taxa.

❌ **Animação em scroll de lista.** Scroll é fluido por natureza; adicionar animação a items que entram no viewport custa CPU e gera ruído visual.

❌ **Loading com mais de 1 elemento animado.** Spinner + skeleton + texto pulsando = caos. Escolha **um**: skeleton, ou spinner, ou texto.

❌ **Transition em `all`.** `transition: all 200ms` pega `width`, `height`, propriedades caras. Sempre liste o que muda: `transition: background 120ms, border-color 120ms`.

❌ **Duração > 500ms em UI funcional.** Modal entrando em 600ms parece travado. Spring/celebration pode ir até 600ms; UI normal nunca.
