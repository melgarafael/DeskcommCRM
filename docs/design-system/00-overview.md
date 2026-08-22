# 00 — Overview

> **Source of truth:** `app/design/README.md`, `app/design/lib/tokens.ts`

## Filosofia

O SonghaiCRM é uma ferramenta operacional para **atendentes que ficam 8 horas por dia em frente à tela**. Toda decisão visual passa por esse filtro: o que reduz fadiga, o que acelera leitura, o que sustenta foco.

Por isso a direção é **soft-tech / calmo**:

- **Soft** — neutros greige (warm-gray), nunca slate/zinc; acentos baixos em saturação; sombras em cor neutra, não preto puro.
- **Tech** — tipografia precisa, dados em mono tabular, hierarquia disciplinada, microinterações com propósito.
- **Calmo** — sem decoração, sem celebração, sem AI-sparkle, sem gradientes. Confiança vem de consistência, não de efeito.

A meta secundária é **não parecer genérico**. 80% dos CRMs SaaS atuais convergem para o mesmo molde (Inter + Lucide + slate + accent indigo + glassmorphism). SonghaiCRM diverge intencionalmente em todas essas escolhas.

## Princípios canônicos

Quando duas decisões parecem igualmente boas, esta lista é a tiebreaker:

1. **Clarity > decoration.** Se um elemento não comunica, ele sai. Sombras decorativas, gradients, ícones que repetem o label — fora.
2. **Calm > vibrant.** Saturação alta cansa; contraste calibrado é mais legível que contraste máximo. Nenhum accent passa de stop 600 em áreas grandes.
3. **Consistency > novelty.** Uma escolha boa repetida 100 vezes é melhor que 100 escolhas únicas. Componentes têm variants finitos e nomeados.
4. **Accessibility > aesthetic.** WCAG AA é piso, não teto. Atkinson Hyperlegible foi escolhida pela disambiguação de glifos. Focus rings sempre 2px visíveis.
5. **Intentional density.** Aerada é default; densidade só comprime quando o conteúdo justifica (tabela de dados). Whitespace não é desperdício, é respiração.

## Estrutura da documentação

Os 11 arquivos desta pasta dividem o sistema em camadas:

- **00–01** — fundação (filosofia + tokens primitivos).
- **02–05** — primitivos visuais (cor, tipo, densidade, ícone).
- **06** — composição (componentes).
- **07–08** — comportamento (motion, voz).
- **09** — guard-rails (anti-patterns).

Leia 00 → 09 sequencial uma vez. Depois consulte por demanda via tabela do `README.md`.

## Versionamento

- **v1.0 — locked em 2026-04-28.** As 5 escolhas (Sage, Atkinson, Aerada, Phosphor, IBM Plex Mono) estão fechadas até v2.0. PRs que tentem trocar uma delas precisam de RFC.
- Patches são aceitos para: novos ícones, novos exemplos de microcopy, ajustes de hex em ±2 pontos de luminosidade quando WCAG falhar, novos componentes derivados.
- Histórico de mudanças vai em `CHANGELOG.md` quando houver primeira mudança.

## Referências

A linguagem do SonghaiCRM toma emprestado partes específicas (não estética inteira) de quatro produtos:

- **Arc browser** — sidebar como "casa", microinterações de hover com propósito espacial, paleta neutra com 1 accent destacado.
- **Notion** — densidade aerada (row 56 / gap 24), tipografia humanista grande, hierarquia por peso e tamanho mais que por cor.
- **Things 3** — calma absoluta, ausência de ornamento, ícones com peso próprio, mono para dados (datas, contadores).
- **Mercury (banking)** — confiança operacional via consistência, paleta greige, números em tabular nums, tom de voz sóbrio em microcopy.

O que **não** importamos: o Geist sans da Vercel/Linear (saturação de mercado), o roxo Linear (overuse), o glass do Mercury (mais tarefa que valor), os gradientes do Arc.
