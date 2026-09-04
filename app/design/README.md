# `/design` — Design System Showcase

> **Nota sobre o nome da pasta:** o briefing pediu `app/_design/`, mas Next.js
> trata folders prefixados com `_` como privados (não geram rota). Para que a
> URL `/design` seja navegável, a pasta foi nomeada `app/design/` (sem
> underscore). Se preferir o prefixo, renomeia e adicione um redirect
> em `next.config.ts`.

Painel navegável e isolado para iterar a direção visual do DeskcommCRM antes de
aplicar ao app real. Não toca em `app/layout.tsx` global; tem o seu próprio
`layout.tsx` com `<VariantProvider>` e CSS escopado em `showcase.css`.

## Como rodar

```bash
pnpm dev
# acesse http://127.0.0.1:3000/design  (ou :3001 se a 3000 estiver ocupada)
```

A rota é pública (sem auth) e tem `robots: noindex`.

## Como ler

1. **Sidebar** — navegação entre 8 seções: Tokens, Paletas, Tipografia,
   Densidade, Componentes, Padrões, Motion, Iconografia.
2. **Top bar** — switcher para trocar **paleta + tipografia + densidade + tema**
   em runtime via CSS Custom Properties. Tudo persiste em
   `localStorage` sob a key `deskcomm.designshowcase.v1`.
3. **Canvas central** — seção ativa, com botões "Aplicar X" embutidos em cada
   variante para trocar diretamente do conteúdo (não só do switcher).

## Direção visual

> Soft-tech / calmo — neutros desaturados (greige/warm-gray, **não** slate/zinc),
> 1 accent forte mas não saturado, motion fluido, whitespace generoso, hierarquia
> tipográfica > decoração.

### Paletas (5)
`Sage` · `Clay` · `Mist` · `Plum` · `Olive` — cada uma com 11 stops do accent,
11 stops de neutro greige, 4 estados (success/warning/error/info), versões
**light e dark definidas separadamente** (não invertidas).

### Pareamentos tipográficos (4)
1. Bricolage Grotesque + Plus Jakarta Sans (default)
2. Fraunces + Manrope
3. Atkinson Hyperlegible (mono-stack a11y-first)
4. Source Serif 4 + IBM Plex Sans

Inter / Geist / Space Grotesk **proibidos** por saturação em training data.

### Densidades (3)
- `Aerada` · row 56 / gap 24 (Notion-like)
- `Equilibrada` · row 44 / gap 16 (Things-like, default)
- `Compacta` · row 32 / gap 8 (Linear-like)

## Arquitetura

- `lib/tokens.ts` — única source-of-truth para cores, fontes, densidade, motion.
- `lib/fonts.ts` — todas as fontes carregadas via `next/font/google` no boot do
  `_design/layout.tsx` (escopo isolado). Variáveis CSS expostas globalmente.
- `lib/variant-context.tsx` — Context React + `setProperty` em `:root` para
  injetar tokens. Hidrata de `localStorage`.
- `showcase.css` — todos os estilos do showcase prefixados `.ds-*`. Não interfere
  no resto do app.
- `sections/Section*.tsx` — uma por aba.
- `components/Switcher.tsx` — controle topo direito.

## Decisões notáveis

- **Default**: `Sage + Bricolage/Jakarta + Equilibrada + Light`. Sage projeta
  calma operacional sem cair em "saúde mental clichê"; Bricolage tem width axis
  útil para hierarquia em headers de inbox.
- **Iconografia recomendada**: Phosphor (duotone). Justificativa na seção Iconografia.
- **CSS variables, não Tailwind classes**: o showcase intencionalmente fica fora
  do tema do app para não poluí-lo antes da decisão final. Quando a variante for
  escolhida, migra-se para o `@theme inline` de `app/globals.css` com
  `var(--accent-N)` e os tokens viram parte do build. (Até o Tailwind 4 o alvo
  era `theme.extend.colors` do `tailwind.config.ts`, que não existe mais.)
