# 05 — Iconografia Phosphor

> **Source of truth:** `@phosphor-icons/react`, peso default `duotone`.

## Por que Phosphor

A iconografia canônica do SonghaiCRM é **Phosphor Icons** com peso **duotone** como default, **regular** como secundário.

Razões:

- **Diferenciação de mercado.** ~80% dos CRMs SaaS atuais usam Lucide (Feather fork). Lucide é correto e neutro, mas previsível. Phosphor diverge sem custo de qualidade — pelo contrário, é mais expressivo.
- **Duotone tem peso visual sem ruído.** A camada secundária (preenchimento ~20% opacity) dá presença sem competir com o texto. Regular fica pra contextos onde duotone seria excessivo (sidebar densa).
- **5 weights disponíveis.** `thin`, `light`, `regular`, `bold`, `duotone`, `fill`. Permite hierarquia dentro do mesmo set sem trocar família.
- **Cobertura grande e consistente.** ~9000 ícones. Cobre todos os domínios do produto (chat, comércio, dados, IA, gestão).
- **Família humanista.** Curvas suaves combinam com Atkinson Hyperlegible. Lucide é mais geométrico, Heroicons é mais "clean SaaS"; Phosphor cabe no soft-tech.

## Instalação

```bash
pnpm add @phosphor-icons/react
```

```tsx
import { ChatCircle, Kanban, UserCircle } from "@phosphor-icons/react";

<ChatCircle weight="duotone" size={20} />
```

## Tamanhos canônicos

Quatro tamanhos. Não invente intermediários.

| Tamanho | px | Uso |
|---------|----|----|
| `xs` | 16 | Inline em texto (parágrafo, badge), trailing em link |
| `sm` | 20 | Sidebar nav, toolbar action, leading em botão |
| `md` | 24 | **Default UI** — header actions, list-item leading, empty-state primário |
| `lg` | 32 | Hero, empty state grande, feature card |

Acima de 32 → use ilustração, não ícone.

## Cor

Ícones consomem `currentColor` ou variáveis específicas. **Nunca** hardcode cor.

```tsx
// Default — herda do parent
<MagnifyingGlass className="text-text-muted" weight="duotone" />

// Em estado ativo (link active, primary button)
<ArrowRight className="text-accent" weight="bold" />

// Decorativo dentro de badge colorido
<CheckCircle className="text-success" weight="duotone" />
```

CSS:

```css
.icon-default { color: var(--ds-text-muted); }
.icon-accent  { color: var(--ds-accent); }
.icon-on-bg   { color: var(--ds-accent-fg); }  /* sobre bg accent */
```

**Duotone:** o peso secundário (preenchimento) usa automaticamente `currentColor` em opacidade reduzida. Não há config extra.

## Mapeamento canônico — função → ícone

Use **estes ícones** para estas funções. Se não está na lista e parece não ter um óbvio, abra RFC antes de escolher.

### Navegação principal

| Função | Ícone Phosphor | Notas |
|--------|----------------|-------|
| Inbox / conversas | `ChatCircle` | duotone, default da home |
| Kanban / pedidos | `Kanban` | duotone |
| Clientes / CRM | `UsersThree` | duotone — não use `User` solo |
| Catálogo / produtos | `ShoppingBag` | duotone |
| Relatórios / analytics | `ChartLine` | duotone (não `ChartBar`) |
| Configurações | `Gear` | regular (não duotone — fica menos formal) |
| Notificações | `Bell` | duotone, com badge se houver pending |

### Ações

| Função | Ícone | Notas |
|--------|-------|-------|
| Buscar | `MagnifyingGlass` | regular |
| Adicionar / criar | `Plus` | bold (peso compensa o tamanho pequeno) |
| Editar | `PencilSimple` | regular (não `Pencil` — tem texturas) |
| Apagar | `Trash` | regular, com cor `error` em ações destrutivas |
| Mais opções | `DotsThree` | regular |
| Filtrar | `Funnel` | regular |
| Ordenar | `ArrowsDownUp` | regular |
| Atribuir / owner | `UserCircle` | duotone |
| Tag / etiqueta | `Tag` | regular |
| Fechar / dismiss | `X` | regular |
| Voltar | `ArrowLeft` | regular |
| Avançar | `ArrowRight` | regular ou bold em CTA |
| Expandir | `CaretDown` | regular |
| Marcar como resolvido | `CheckCircle` | duotone, cor `success` |
| Reabrir conversa | `ArrowCounterClockwise` | regular |

### Estado e status

| Função | Ícone | Notas |
|--------|-------|-------|
| Sucesso / OK | `CheckCircle` | duotone, cor `success` |
| Aviso | `Warning` | duotone, cor `warning` (não `WarningCircle` — visual diferente) |
| Erro / urgente | `WarningOctagon` | duotone, cor `error` |
| Info / dica | `Info` | duotone, cor `info` |
| Loading | `CircleNotch` (com spin) | regular |
| Skeleton placeholder | sem ícone | use `<Skeleton>` shadcn |

### Mensagens (chat)

| Função | Ícone | Notas |
|--------|-------|-------|
| Anexar arquivo | `Paperclip` | regular |
| Imagem | `Image` | regular |
| Áudio | `Microphone` | regular |
| Enviar | `PaperPlaneRight` | bold |
| Emoji | `Smiley` | regular |
| Template / shortcut | `Lightning` | duotone (uso operacional, **não usar pra IA**) |
| Ack: enviado | `Check` | regular, text-muted |
| Ack: entregue | `Checks` | regular, text-muted |
| Ack: lido | `Checks` | regular, text-accent (cor pra diferenciar) |

### IA / automação

| Função | Ícone | Notas |
|--------|-------|-------|
| IA respondendo | `Brain` ou `Sparkle` | duotone — **`Sparkle` apenas** se tom for de "sugestão criativa"; `Brain` pra "processamento" |
| Sugestão automática | `MagicWand` | duotone (raro) |

> ⚠️ **Não use `Lightning` para IA.** Lightning é reservado pra "shortcuts/templates" do atendente. Trocar gera ambiguidade.

### Comércio

| Função | Ícone | Notas |
|--------|-------|-------|
| Pedido / sacola | `ShoppingBag` | duotone |
| Pagamento | `CreditCard` | duotone |
| Frete / envio | `Truck` | duotone |
| Produto único | `Package` | regular |
| Cupom / desconto | `TicketDiscount` | duotone |

## Quando NÃO usar ícone

- **Em label puramente verbal** onde o texto é mais claro. Ex: botão `Salvar` não precisa de ícone; `Marcar como resolvido` precisa de `CheckCircle` porque o texto é longo.
- **Em estados onde a cor já comunica.** Badge `success` verde com texto "Pago" não precisa de ícone — economiza espaço.
- **Em ícone redundante.** Não coloque `MagnifyingGlass` antes de um input com placeholder "Buscar conversas".
- **Decoração pura.** Toda ocorrência de ícone deve ter função (affordance, status, navegação).

## Acessibilidade

```tsx
// Ícone que é a única affordance (icon-only button)
<button aria-label="Apagar conversa">
  <Trash size={20} weight="regular" />
</button>

// Ícone decorativo ao lado de texto (texto já comunica)
<button>
  <Plus size={16} weight="bold" aria-hidden="true" />
  <span>Nova conversa</span>
</button>

// Ícone de status com label
<span role="status">
  <CheckCircle size={16} weight="duotone" className="text-success" aria-hidden="true" />
  <span>Resolvido</span>
</span>
```

**Regras:**
- Icon-only button → `aria-label` obrigatório.
- Ícone + texto → `aria-hidden="true"` no ícone.
- Ícone de status → ou role/aria-label, ou texto adjacente sempre presente (mesmo que sr-only).
- Phosphor renderiza como `<svg>`, então ele já é tratável por screen readers conforme attrs.
