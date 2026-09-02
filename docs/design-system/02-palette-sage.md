# 02 — Paleta Accent (verde-WhatsApp)

> **Source of truth:** `app/design/lib/tokens.ts` → `PALETTES.sage.accent` (o `id` interno
> da paleta continua `sage` — é um identificador de código, não a identidade visual; ver
> a nota de nomenclatura no fim do arquivo).
>
> ⚠️ **Rebrand de 2026-09-01:** a paleta era Sage (verde-erva desaturado, seed `#506d48`).
> A partir desta data o accent do produto é o verde característico do WhatsApp (seed
> `#008069`, grau 600). Os números abaixo foram recalculados com as funções reais de
> `lib/branding/rampa.ts` e `lib/branding/contraste.ts` — nenhum é estimado.

## Filosofia da paleta

O accent é o verde do WhatsApp: o canal primário do produto é WhatsApp, e a cor reforça
essa associação em vez de competir com ela. É mais saturado que a Sage antiga (chroma
OKLab ~0,10–0,11 no miolo da rampa, contra algo mais dessaturado antes), mas continua:

- **Calma sem fragilidade** — nem neon, nem pastel; é a cor de uma ferramenta de trabalho,
  não de um app de bem-estar.
- **Confiança warm** — neutros greige (warm-gray, base bege/oliva) ao invés de slate/zinc,
  que carregam tom corporativo frio. Os neutros **não mudaram** neste rebrand.
- **Reconhecível** — quem já usa WhatsApp reconhece o verde no primeiro clique.
- **Funcional em monitores 8h/dia** — luminosidade calibrada pra não cansar; backgrounds
  nunca puro `#fff` (offwhite warm) nem puro `#000` (very-dark warm).

A paleta tem **dois temas desenhados independentemente**, não invertidos. Light não é dark
com inversão de luminosidade; cada um foi calibrado pra contraste e conforto na sua direção.

## Light theme — accent (verde-WhatsApp)

| Stop | Hex | Uso prescrito |
|------|-----|---------------|
| 50 | `#eef8f4` | Background de hover muito sutil, soft chip background |
| 100 | `#d9efe8` | `--color-accent-soft` — bg de badge accent, hover de nav-link, focus ring outer |
| 200 | `#b3dfd1` | Borders de elementos accent secundários |
| 300 | `#80c7b3` | Disabled state do accent, decorative dividers |
| 400 | `#49b198` | Hover de elementos accent claros |
| 500 | `#169b80` | Anel de foco (`--ring`, `:focus-visible/outline`) — ver nota de contraste abaixo |
| 600 | `#008069` | **Brand accent canônico do tema claro** (`--color-accent`) — botão primary bg, link |
| 700 | `#136553` | Hover de primary button (escurece) |
| 800 | `#175244` | Pressed state de primary button |
| 900 | `#194439` | Texto sobre fundos accent claros (a11y AAA) |
| 950 | `#08221b` | — (uso extremo, evite) |

> **Nota de nomenclatura:** esta tabela descreve os stops como o `globals.css` os declara.
> `app/design/lib/tokens.ts` documenta usos previstos que podem diferir do que o produto
> usa hoje — `globals.css` é a fonte de verdade para o que está de fato no ar.

## Light theme — neutral greige

*(inalterado pelo rebrand — o neutro nunca foi Sage)*

| Stop | Hex | Uso prescrito |
|------|-----|---------------|
| 50 | `#faf9f6` | `--ds-bg` — page background (offwhite warm) |
| 100 | `#f3f1ec` | Background de seções, alt-row de tabela |
| 200 | `#e7e3da` | `--ds-border` — borders default |
| 300 | `#d2cdbf` | Borders mais firmes, divider de tabela |
| 400 | `#a9a395` | Placeholder text, ícone disabled |
| 500 | `#7d786c` | Texto utilitário (timestamp, helper) |
| 600 | `#5d594f` | `--ds-text-muted` — texto secundário, label |
| 700 | `#46433b` | Texto importante mas não primary |
| 800 | `#2e2c26` | Heading secundário |
| 900 | `#1c1a16` | `--ds-text` — texto primary (corpo, headings) |
| 950 | `#0e0d0a` | Texto extremamente alto contraste (raro) |

**Surfaces light:**
- `bg`: `#faf9f6` — página
- `surface`: `#ffffff` — cards e superfícies elevadas (puro branco)
- `surfaceElevated`: `#f5f3ee` — alt-bg, header, dropdown bg
- `text`: `#1c1a16` / `textMuted`: `#5d594f` / `border`: `#e7e3da`

## Dark theme — accent (verde-WhatsApp, ajustado)

| Stop | Hex | Uso prescrito |
|------|-----|---------------|
| 50 | `#eef8f4` | Texto sobre fundo accent escuro (raro) |
| 100 | `#d9efe8` | — |
| 200 | `#b3dfd1` | — |
| 300 | `#80c7b3` | Hover state em link |
| 400 | `#49b198` | **Brand accent em dark** (`--color-accent`) — primary button bg, link, focus |
| 500 | `#169b80` | Versão mais saturada do accent em dark, alguns hovers |
| 600 | `#008069` | Hover ainda mais escuro (raro) |
| 700 | `#136553` | Border accent em dark |
| 800 | `#175244` | Soft accent bg (badges) |
| 900 | `#194439` | Soft accent bg (mais discreto) |
| 950 | `#08221b` | Background quase invisível (decorativo) |

> **Nota:** em dark, o "primary" sobe pro stop 400 (mais luminoso) pra preservar contraste
> sobre fundos escuros — igual valia na Sage.

## Dark theme — neutral greige

*(inalterado pelo rebrand)*

| Stop | Hex | Uso prescrito |
|------|-----|---------------|
| 50 | `#f5f4ef` | `--ds-text` — texto primary em dark |
| 100 | `#e6e4dc` | Texto sobre surface escuro (alta hierarquia) |
| 200 | `#bbb8ac` | Texto importante em dark |
| 300 | `#8e8b7f` | `--ds-text-muted` — texto secundário |
| 400 | `#605e54` | Placeholder, helper |
| 500 | `#444239` | Disabled |
| 600 | `#33312a` | `--ds-border` — borders default |
| 700 | `#272620` | `--ds-surface-elevated` — header, dropdown |
| 800 | `#1d1c17` | `--ds-surface` — cards |
| 900 | `#161510` | `--ds-bg` — page background (very-dark warm) |
| 950 | `#0c0b08` | Voids decorativos (raro) |

**Surfaces dark:**
- `bg`: `#161510` — página (NÃO `#000` nem `#0a0a0a`; warm-tinted)
- `surface`: `#1d1c17` — cards
- `surfaceElevated`: `#272620` — header, dropdown
- `text`: `#f5f4ef` / `textMuted`: `#8e8b7f` / `border`: `#33312a`

## Estados (success / warning / error / info)

*(inalterados pelo rebrand — são slots semânticos independentes do accent, não derivados
dele. A coincidência de `success` dark com o antigo `accent-400` era acaso da Sage; com o
verde-WhatsApp os dois já não são a mesma string, mas ficam perto o bastante sob simulação
de dicromacia para a reconciliação de `lib/branding/contraste.ts` ainda entrar em ação —
ver `tests/unit/branding-contraste.test.ts`.)*

| Estado | Light | Dark | Uso |
|--------|-------|------|-----|
| `success` | `#5a8a5f` | `#82a077` | Confirmação positiva, status "ativo", "lido" |
| `warning` | `#b07a2b` | `#d09455` | Atenção sem urgência, SLA próximo de vencer |
| `error` | `#a94a3c` | `#c87263` | Erro, ação destrutiva, SLA estourado |
| `info` | `#4a7a93` | `#7da9bf` | Mensagem informativa, dica |

**Como aplicar estados (3 padrões):**

```css
/* 1. Como bg de badge: estado a 14% transparência + estado como fg */
.badge-success {
  background: color-mix(in srgb, var(--ds-success) 14%, transparent);
  color: var(--ds-success);
}

/* 2. Como border (foco específico): full opacity */
.input-error { border-color: var(--ds-error); }

/* 3. Como bg de botão destrutivo: full opacity, fg branco */
.btn-destructive { background: var(--ds-error); color: #fff; }
```

## Contraste WCAG

Validações recalculadas com `razaoDeContraste` (`lib/branding/contraste.ts`) sobre a rampa
atual:

| Combinação | Ratio | Nível | OK pra |
|------------|-------|-------|--------|
| `text` (`#1c1a16`) sobre `bg` (`#faf9f6`) | 16,50:1 | AAA | Prosa longa, body text |
| `text-muted` (`#5d594f`) sobre `bg` | 6,63:1 | AA+ | Secondary, helper, timestamps |
| `accent-600` (`#008069`) sobre `bg` | 4,65:1 | AA | Texto UI 14px+, botão primary (claro) |
| `accent-500` (`#169b80`) sobre `bg` | 3,31:1 | AA componente (3:1) | Anel de foco — **não** para texto 14px+ |
| `accent-700` (`#136553`) sobre `accent-soft` | 5,79:1 | AAA | Link em chip, label sobre badge |
| Dark: `text` (`#f5f4ef`) sobre `bg` (`#161510`) | 16,60:1 | AAA | Body text |
| Dark: `accent-400` (`#49b198`) sobre `bg` | 6,99:1 | AA+ | Link, primary |
| `error` light (`#a94a3c`) sobre `bg` | 5,34:1 | AA | UI text 14px+ |

⚠️ **`accent-500` caiu de ~4,6:1 (Sage) para 3,31:1** com o verde-WhatsApp — ainda cobre o
piso de **componente** (3:1, WCAG 1.4.11), mas não cobre mais o piso de **texto** (4.5:1).
Isto só importa onde 500 pinta TEXTO; hoje ele só pinta o anel de foco, que é componente.
Um achado relacionado, mais estreito, está documentado em
`tests/unit/branding-contraste.test.ts` (suíte "cabe nos pisos"): no tema claro, o par
`:focus-visible/outline` (accent-500) × `--color-accent-soft` (accent-100) mede 2,89 — abaixo
até do piso de componente — no CSS estático (sem a caminhada de contraste). É uma decisão de
produto em aberto (ajustar a curva da rampa, trocar o stop do anel, ou aceitar a exceção
documentada), não uma regressão silenciosa.

**Regras:**
- Body text e prosa: AAA mínimo (`text` + `bg`).
- UI text 14px+: AA mínimo (4.5:1).
- Componentes não-textuais (borders, ícones): AA UI mínimo (3:1).
- Nunca usar `text-muted` para texto em prosa longa (apenas labels, helpers, timestamps).

## Anti-padrões — como NÃO usar o accent

❌ **Saturar accent além de 700.** Stops 800–950 só pra texto em fundo claro accent, nunca
como bg de área grande.

❌ **Accent como bg de toda a sidebar.** Sidebar é greige (`surface` ou `surface-elevated`).
Accent na sidebar fica como hover-state e active-state apenas.

❌ **Accent em texto de longa leitura.** Body de e-mail, descrição de pedido, prosa de doc —
tudo `text` (`#1c1a16`). Accent só em link, label de status, ações.

❌ **`#000` ou `#fff` puro.** Texto preto puro contra bg warm-offwhite cria vibração; use
`#1c1a16` e `#faf9f6`.

❌ **Misturar o accent com cores fora dos estados.** Não importe roxo, azul-bandeira, ciano
— não fazem parte do sistema. Se precisa diferenciar tags do usuário, use stops do greige +
1 acento; se precisa de cores categóricas (gráfico), abrir RFC.

❌ **Gradients accent → accent.** O produto não usa gradients; use solid + shadow se
precisar profundidade.

## Acessibilidade (visão de cor)

Medido com `simularDicromacia` (`lib/branding/contraste.ts`) sobre a rampa atual — o accent
tem matiz OKLab ~174° (teal/verde-azulado), croma ~0,10–0,11 no miolo da rampa:

- **Deuteranopia** (verde-cego, ~6% homens): `accent-500` (`#169b80`) colapsa para um
  cinza-azulado (`#858582`) e cai para ~3,51:1 contra `bg` — ainda cobre o piso de
  componente (3:1), não o de texto. Diferenciação verde-vermelho dos estados (`success` vs
  `error`) continua preservada porque `error` é warm-red, não puro green/red.
- **Protanopia** (vermelho-cego): comportamento parecido; o accent também colapsa para um
  tom acinzentado, sem virar indistinguível do neutro.
- **Tritanopia** (azul-amarelo, raro): menos afetada — o matiz teal do accent fica mais
  perto do eixo que a tritanopia preserva.

Em todos os casos, **nunca dependa só de cor pra comunicar estado**. Use ícone Phosphor +
cor + label de texto. Ex: badge de SLA estourado tem cor error, ícone `Warning`, e texto
"Vencido há 2h".
