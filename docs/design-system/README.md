# Design System SonghaiCRM — Documentação Canônica

> **Versão:** v1.0 (lockada em 2026-04-28)
> **Status:** Ativa
> **Direção:** Soft-tech / calmo, anti-genérico
> **Stack visual:** Sage + Atkinson Hyperlegible + IBM Plex Mono + Aerada + Phosphor (duotone)

Esta pasta é a **fonte canônica** da linguagem visual do SonghaiCRM. Toda decisão de UI deve consultar estes documentos antes de implementação. Quando houver conflito entre código e doc, **a doc vence** — ajuste o código.

## Índice

| # | Documento | O que cobre |
|---|-----------|-------------|
| 00 | [Overview](./00-overview.md) | Filosofia, princípios, referências |
| 01 | [Foundation Tokens](./01-foundation-tokens.md) | Spacing, radius, shadow, motion, z-index |
| 02 | [Paleta Sage](./02-palette-sage.md) | 22 stops com hex (light + dark), estados, contraste |
| 03 | [Tipografia](./03-typography.md) | Atkinson Hyperlegible, escala, IBM Plex Mono |
| 04 | [Densidade Aerada](./04-density-aerada.md) | Row 56 / gap 24, quando overrider |
| 05 | [Iconografia Phosphor](./05-iconography-phosphor.md) | Duotone, mapeamento por feature |
| 06 | [Componentes](./06-components.md) | shadcn customizado + componentes do produto |
| 07 | [Motion Language](./07-motion-language.md) | 4 tipos canônicos, curvas, durations |
| 08 | [Voz e Tom](./08-voice-and-tone.md) | PT-BR profissional calmo, microcopy |
| 09 | [Anti-patterns](./09-anti-patterns.md) | O que não fazer, com alternativas |

## Mapa decisão → source of truth

| Decisão | Onde está canonizada | Quando consultar |
|---------|----------------------|------------------|
| Cor (hex, stop, estado) | `02-palette-sage.md` + `app/design/lib/tokens.ts` | Sempre que precisar referenciar uma cor |
| Spacing / radius / shadow | `01-foundation-tokens.md` + `app/design/lib/tokens.ts` | Toda vez que escrever CSS de layout |
| Tamanho/peso de texto | `03-typography.md` | Ao criar headers, body, dados, captions |
| Altura de linha de inbox / kanban / tabela | `04-density-aerada.md` | Ao desenhar listas e grids |
| Qual ícone usar para feature X | `05-iconography-phosphor.md` | Ao adicionar novo ícone |
| Variant/state de um componente shadcn | `06-components.md` | Antes de criar novo componente |
| Duração e curva de animação | `07-motion-language.md` | Toda vez que adicionar `transition` ou `animation` |
| Copy de erro/sucesso/empty | `08-voice-and-tone.md` | Ao escrever microcopy |
| "Posso usar X?" (Inter, gradient roxo, etc.) | `09-anti-patterns.md` | Quando em dúvida sobre uma escolha |

## Source of truth (código)

- `app/design/lib/tokens.ts` — tokens em TypeScript (cor, spacing, radius, shadow, motion)
- `app/design/lib/fonts.ts` — config das fontes via `next/font/google`
- `app/design/showcase.css` — CSS vars `.ds-*` canônicas
- `app/design/` — showcase navegável em `/design`

## Versionamento

- **v1.0** (2026-04-28) — paleta Sage, tipografia Atkinson, densidade Aerada, iconografia Phosphor lockados.
- Mudanças de versão maior exigem PR + revisão do design owner. Patches (ajuste de hex em ±2 luminosidade, novos ícones, novos exemplos de microcopy) podem ir direto.
