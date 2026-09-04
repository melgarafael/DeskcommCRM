# 03 — Tipografia

> **Source of truth:** `app/design/lib/fonts.ts` (`atkinson`, `plexMono`), `app/design/lib/tokens.ts` → `TYPOS.atkinson`

## Por que Atkinson Hyperlegible

A fonte de display + body do DeskcommCRM é **Atkinson Hyperlegible**, criada pelo Braille Institute em 2020 com um único objetivo: **maximizar a distinção entre caracteres similares** para usuários com baixa visão.

Razões da escolha:

- **Acessibilidade-first.** `0` vs `O`, `1` vs `l` vs `I`, `rn` vs `m`, `B` vs `8` — todos disambiguados por design. Crítico em CRM onde número de pedido (`#01430`) e código de cliente (`Bl0OO1`) precisam ser lidos sem ambiguidade.
- **Humanista, não geométrica.** Curvas levemente abertas, terminais não-mecânicos. Diferencia do par Inter/Geist (geométrico, dominante no SaaS atual).
- **Baseline alta, x-height generosa.** Confortável em 12–13px, que é onde acontece 80% da UI operacional (timestamps, helpers, dados de tabela).
- **Anti-genérica.** Quase ninguém em CRM SaaS usa Atkinson. Diverge sem custo de legibilidade — pelo contrário, ganha.
- **Mesma família display + body.** Reduz cognição na hierarquia: o que muda é peso e tamanho, não tipo. Combina com Aerada (a hierarquia vem do whitespace).

A fonte secundária para **dados monoespaçados** é **IBM Plex Mono** — escolhida por ter a mesma sensibilidade humanista (pertence à família Plex, da IBM) sem cair em JetBrains Mono (saturação developer-tools) nem Fira Code (ligatures que confundem em UI).

## Stack completo

```css
--ds-font-display: var(--font-atkinson), ui-sans-serif, system-ui, sans-serif;
--ds-font-body:    var(--font-atkinson), ui-sans-serif, system-ui, sans-serif;
--ds-font-mono:    var(--font-plex-mono), ui-monospace, "SF Mono", Menlo, monospace;
```

`var(--font-atkinson)` é injetado por `next/font/google` via `app/design/lib/fonts.ts`.

**Pesos disponíveis** (Atkinson):
- 400 — body, default UI
- 700 — bold, headings, ênfase

Itálico disponível em ambos. Não há 500/600 — quando precisar de "semibold", use 700 com tamanho menor, ou aceite que peso 400 é o body.

**Pesos disponíveis** (IBM Plex Mono):
- 400 — default mono
- 500 — emphasis em mono (raro)

## Escala tipográfica

Modular ratio: **1.250 (minor third)**, com ajustes manuais em alguns stops para alinhar pixel-grid.

| Token | Tamanho | Line-height | Peso | Tracking | Uso |
|-------|---------|-------------|------|----------|-----|
| `display-xl` | 48px | 56px | 700 | -1% | Hero raríssimo (página de boas-vindas) |
| `display-lg` | 36px | 44px | 700 | -0.5% | Hero de página de feature, marketing-style |
| `display-md` | 28px | 36px | 700 | 0 | Header de view (`Inbox`, `Kanban`) |
| `display-sm` | 24px | 32px | 700 | 0 | Header de seção em página densa |
| `h1` | 20px | 28px | 700 | 0 | Títulos de card grande, modal title |
| `h2` | 18px | 24px | 700 | 0 | Subtítulo, header de coluna |
| `h3` | 16px | 22px | 700 | 0 | Card title, group label em form |
| `body-lg` | 16px | 24px | 400 | 0 | Body de prosa (descrição, comentário) |
| `body` | 14px | 20px | 400 | 0 | **Default UI** — labels, copy de botão, item de lista |
| `body-sm` | 13px | 18px | 400 | 0 | Helper, preview de mensagem em inbox, secondary text |
| `caption` | 12px | 16px | 400 | 0.5% | Timestamp, badge label, microcopy |
| `mono-data` | 13px | 18px | 400 | 0 | **IBM Plex Mono** — IDs, valores, datas tabulares |

**Regras de uso:**

- Não invente tamanhos intermediários. Se 14 e 16 não cabem, repense o layout.
- `tracking` (letter-spacing) só nos extremos da escala: negativo nos display (compactar), positivo no caption (legibilidade).
- **Line-height nunca abaixo de 1.4** em prosa (`body-lg`, `body`). UI compacta pode ir até 1.35 (caption).

## Numerais

Atkinson Hyperlegible suporta **tabular nums** via `font-feature-settings`. Aplicado obrigatoriamente em:

```css
.tabular {
  font-variant-numeric: tabular-nums;
}
```

**Quando usar tabular-nums (largura igual por dígito):**
- IDs de pedido (`#12.443`)
- Preços (`R$ 247,90`)
- Datas e horários (`14:32`, `28/04`)
- Contadores em colunas (`Pedidos: 1.247`)
- Qualquer número em tabela ou lista alinhada

**Quando manter proporcional (default):**
- Números em prosa (`Você tem 3 conversas pendentes`)
- Números pequenos isolados em meio a texto

Em IBM Plex Mono o tabular já é nativo (toda mono é tabular).

## Itálico

Itálico tem **uso semântico**, não decorativo:

✅ Sim — citar texto literal (`A cliente disse: "ainda não chegou"`)
✅ Sim — termo técnico em primeira ocorrência
✅ Sim — placeholder explicativo (`exemplo: nome do produto`)

❌ Não — destacar palavras pra "dar charme"
❌ Não — em headings (nunca)
❌ Não — em microcopy de botão

## Hierarquia em UI real

Exemplo canônico: **item de inbox**.

```tsx
<div className="ds-list-item">
  <Avatar />
  <div className="body">
    <span className="title">João Silva — Pedido #12.443</span>          {/* body, weight 700 implicit via .title */}
    <span className="preview">"Olá, ainda não recebi rastreio…"</span>  {/* body-sm, text-muted */}
  </div>
  <div className="meta">
    <span className="ts tabular">14:32</span>                            {/* caption, tabular, mono opcional */}
    <Badge variant="success">Resolvido</Badge>                           {/* caption peso 500 */}
  </div>
</div>
```

Detalhes a observar:
- O nome da pessoa e o ID do pedido convivem na mesma linha porque hierarquia é dada por `weight` + `text-muted`, não por tamanho diferente.
- ID `#12.443` está em sans (Atkinson) com `font-variant-numeric: tabular-nums` porque é um número curto inline; quando vira coluna de tabela, vira `mono-data` (Plex Mono).
- Timestamp em `caption` + `tabular` para alinhar verticalmente entre rows.

Outro exemplo: **header de view**.

```tsx
<header>
  <h1 className="display-md">Inbox</h1>                {/* 28px / 700 */}
  <p className="body-sm text-muted">42 conversas abertas · 3 vencendo SLA</p>
</header>
```

## Acessibilidade

- **Tamanho mínimo:** 12px (`caption`). Abaixo disso só ícones com `aria-label`.
- **Line-height mínimo:** 1.4 em prosa, 1.35 em UI compacta.
- **Tracking:** já calibrado por escala. Não sobrescreva sem motivo (legível ou marketing).
- **Peso mínimo de leitura:** 400 sempre. Light (300) não existe na escala — Atkinson não tem 300 carregado.
- **Foco visual:** texto em `text-muted` (`#5d594f` light / `#8e8b7f` dark) só pra UI 14px+; nunca aplicar a prosa longa.
- **Truncate:** sempre com `text-overflow: ellipsis` + `white-space: nowrap` + `min-width: 0`. Tooltip com texto completo no hover (`<Tooltip>` shadcn).

## Como consumir em código

```tsx
// Tailwind (mapeado no `@theme inline` de app/globals.css)
<h1 className="text-display-md font-bold tracking-tight">Inbox</h1>
<p className="text-body-sm text-muted">42 abertas</p>
<span className="font-mono text-mono-data tabular-nums">#12.443</span>

// CSS direto (showcase ou estilos globais)
.title { font-family: var(--ds-font-display); font-size: 28px; line-height: 36px; font-weight: 700; }
.id    { font-family: var(--ds-font-mono);    font-size: 13px; line-height: 18px; font-variant-numeric: tabular-nums; }
```
