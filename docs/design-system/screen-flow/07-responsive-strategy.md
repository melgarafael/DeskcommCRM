---
title: Responsive Strategy
parent: README.md
fonte: Sub-PRD 04 §3.10 + design-system base
version: 0.1
date: 2026-04-28
---

# 07 — Responsive Strategy

> Como cada superfície responde a cada breakpoint. **Desktop ≥1280px é o foco MVP** (atendente passa o dia em laptop). Mobile não é foco mas degrada graciosamente para o atendente em deslocamento.

## Breakpoints canônicos

| Token | Largura | Uso primário |
|---|---|---|
| `desktop` | ≥1280px | **default** — design otimizado |
| `laptop` | 1024–1279px | aceito sem degradação grave |
| `tablet` | 768–1023px | "stacked" — layouts mudam |
| `mobile` | 360–767px | atendente em deslocamento; somente leitura/quick-reply em algumas telas |

Tailwind: `lg:` ≥1024, `xl:` ≥1280, `2xl:` ≥1536. Para um ponto de corte próprio
de tablet, declare `--breakpoint-<nome>` no `@theme inline` de `app/globals.css`
(no Tailwind 4 não há mais `screens` em config JS).

## Princípios

1. **Desktop-first** no Tailwind (classes default são desktop; sobreescritas via `max-md:` etc) — invertido do default Tailwind por convicção; reflete uso real.
2. **`100dvh` em vez de `100vh`** sempre que altura cheia (Safari iOS — Sub-PRD 04 §3.10).
3. **`safe-area-inset-bottom`** em qualquer composer ou bottom-bar (notch).
4. **Tap targets ≥44×44px** em mobile (Apple HIG); ≥40px em touch laptop.
5. **Drag-drop não suportado em mobile** no MVP — Kanban vira read-only com tap-menu pra mover.
6. **Cross-tenant features (super-admin) não otimizam pra mobile** — operação BPO assume desktop sempre.

## Por superfície

### Inbox (Sub-PRD 04 §3.6)

| Breakpoint | Layout | Comportamento |
|---|---|---|
| desktop | 3 colunas: 320px / fluida / 360px | divisor arrastável; tudo visível simultaneamente |
| laptop | 3 colunas: 280px / fluida / 320px | leve compressão; sem perder feature |
| tablet | 2 rotas: `/app/inbox` (lista) e `/app/inbox/[id]` (thread + drawer side panel) | clique na conversation navega; back arrow volta pra lista |
| mobile | 2 rotas idênticas ao tablet | side panel vira **bottom sheet** (decisão preferida pelo Sub-PRD 04 §9 entry 7); `<CRMSidePanel>` aberto via FAB ou swipe-up |

**Decisão UX**: side panel em mobile vira **bottom sheet** com 3 stops (peek 80px / metade 50% / cheio 100dvh) — melhor que drawer lateral pra preservar contexto da thread.

### Kanban (Sub-PRD 04 §3.1)

| Breakpoint | Layout | Comportamento |
|---|---|---|
| desktop | colunas lado-a-lado, scroll horizontal se >5 stages | drag-drop fluido |
| laptop | idem, possivelmente 1 coluna a menos visível | scroll horizontal natural |
| tablet | scroll horizontal com snap por coluna | tap em card abre detail; long-press → menu "Mover pra…" |
| mobile | **lista vertical empilhada** com headers de stage colapsáveis OU swipe horizontal com snap | drag-drop **desabilitado**; mover via tap-menu |

### Customer 360 (`/app/contacts/[id]`)

| Breakpoint | Layout |
|---|---|
| desktop | 2 colunas: header full-width; depois 60% timeline + 40% sidebar (orders, conversations, consent) |
| laptop | idem |
| tablet | 1 coluna empilhada; sidebar vira accordion abaixo da timeline |
| mobile | bottom sheet pro Customer 360 quando aberto a partir da inbox; rota dedicada `/app/contacts/[id]` é página inteira empilhada |

### Pipelines list / settings

| Breakpoint | Layout |
|---|---|
| desktop / laptop | tabela cheia com todas as colunas |
| tablet | colunas críticas (nome, vocabulary, leads count); resto em expand row |
| mobile | cards empilhados (1 pipeline por card) |

### Audit log

| Breakpoint | Layout |
|---|---|
| desktop / laptop | tabela com filtros laterais |
| tablet | filtros viram top-bar collapsible; tabela com scroll horizontal |
| mobile | lista de cards (1 entrada por card); detail full-screen |

### LGPD requests

| Breakpoint | Layout |
|---|---|
| desktop / laptop | lista + detail side-by-side opcional (split view) |
| tablet / mobile | navegação rota-a-rota; detail full screen |

### Super-admin (`/admin/*`)

**Mobile**: degradado intencionalmente. Mostra banner amber: "Plataforma otimizada pra desktop. Algumas ações estão desabilitadas." — operadora sabe que precisa de laptop pra triagem séria.

| Breakpoint | Comportamento |
|---|---|
| desktop / laptop | full feature |
| tablet | layouts colapsam mas operação possível |
| mobile | **read-only**: dashboard, alerts, listas; bloqueio em mutações destrutivas (criar tenant, impersonate, reassign batch); inbox cross-tenant funciona como inbox normal |

### Onboarding

| Breakpoint | Comportamento |
|---|---|
| desktop / laptop | wizard 50% width centrado; sidebar com stepper |
| tablet | wizard 80% width; stepper top bar |
| mobile | wizard full-width; stepper colapsa em "Passo 2 de 5" |

QR code pra connect-whatsapp em mobile: tamanho fixo 280×280 e instrução "abra WhatsApp em outro celular" — não se conecta consigo mesmo.

## Componentes específicos

### `<ComposerBar>` (Sub-PRD 04 §3.6)

- Desktop: textarea auto-resize 1–6 linhas; toolbar inline (paperclip, emoji, send, quick-replies)
- Tablet/Mobile: textarea 1–4 linhas; toolbar reduzida; emoji picker em bottom sheet
- `safe-area-inset-bottom` sempre
- Não coberto por teclado virtual: usar `position: sticky` + scroll manual da thread

### `<KanbanCard>`

- Desktop: 280–320px de largura, todas as info visíveis
- Tablet: 240px
- Mobile: 100% width na lista vertical OU 85vw com snap no swipe horizontal

### `<CRMSidePanel>`

- Desktop: 360px fixa
- Tablet: drawer lateral 70vw
- Mobile: bottom sheet 3-stops

### Toasts/Notifications

- Desktop: bottom-right, max 3 visíveis
- Mobile: bottom-center, full-width com `safe-area-inset-bottom`

### Modal/Dialog

- Desktop: centered, max-width 560px
- Tablet/Mobile: full-screen modal com header back arrow

## Regras universais

1. **Imagens em mensagens** sempre `max-width: 100%`, mantendo aspect ratio
2. **Mídia preview** clicável → lightbox full-screen
3. **Foco visível** sempre (`focus-visible:ring-2 ring-sage-500`)
4. **Hover states** apenas com `@media (hover: hover)` (não em touch)
5. **Atalhos de teclado** invisíveis em mobile (não confunde)

## Testes visuais obrigatórios

- iPhone 14 Safari (mobile referência)
- iPad Air Safari (tablet referência)
- MacBook Air 13" Chrome (laptop referência)
- 27" desktop Chrome (desktop referência)
- Pixel 7 Chrome (Android touch referência)

Capturas de cada superfície em cada breakpoint vão pra Storybook (Fase 1.5).
