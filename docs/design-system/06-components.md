# 06 — Componentes

> **Source of truth:** `components/ui/*` (shadcn customizado), `app/design/showcase.css` (`.ds-*` canônicos).

Inventário completo dos componentes de UI do SonghaiCRM. Cada um tem variants finitos, states nomeados e regras de uso. Não fork, não custom-CSS solto: se um componente precisa de variant novo, ele entra aqui.

## Componentes shadcn instalados

Localização: `components/ui/`. Os 14 instalados (ver `ls components/ui/`):

`avatar` · `badge` · `button` · `card` · `dialog` · `dropdown-menu` · `input` · `label` · `scroll-area` · `separator` · `sheet` · `skeleton` · `sonner` · `tabs` · `textarea`

Próximas adições previstas (não instalados ainda): `tooltip`, `select`, `command`, `popover`, `toggle`, `progress`. Quando chegarem, atualizar este doc.

---

## Button

5 variants × 4 states. Altura fixa 36px (não escala com densidade).

| Variant | bg | fg | Border | Uso |
|---------|----|----|--------|-----|
| `primary` | `accent` | `accent-fg` | none | Ação principal da view (1 por contexto, idealmente) |
| `secondary` | `surface-elevated` | `text` | `border` | Ação secundária ao lado da primary |
| `ghost` | transparent | `text` | none | Ações de toolbar, ícones com hover sutil |
| `destructive` | `error` | `#fff` | none | Apagar, cancelar definitivamente, ações irreversíveis |
| `link` | transparent | `accent` | none | Inline em texto, navegação textual |

States: `default`, `hover`, `active`, `disabled`, `focus-visible`. Focus sempre `outline: 2px solid var(--ds-accent)` com `outline-offset: 2px`.

```tsx
<Button variant="primary">Salvar</Button>
<Button variant="secondary"><Plus size={16} aria-hidden /> Nova conversa</Button>
<Button variant="destructive">Apagar conversa</Button>
```

**Regra de composição:** primary à direita em pares (Salvar/Cancelar), com Cancelar como `ghost` (não `secondary`).

---

## Input

Altura 36px. Border `border-thin` default, `border-focus` 2px no focus.

| Variant/state | Como ativar | Visual |
|---------------|-------------|--------|
| `default` | — | border `border`, bg `bg` |
| `with-icon` | `<Input leadingIcon={<MagnifyingGlass/>}/>` | Padding-left 36px, ícone inserido |
| `error` | `aria-invalid="true"` | border `error`, focus ring `error/18%` |
| `disabled` | `disabled` | opacity 0.55, cursor not-allowed |
| `focus` | tab/click | border `accent`, box-shadow `0 0 0 3px var(--ds-accent-soft)` |

Search input usa o mesmo Input com `type="search"` + leading `MagnifyingGlass`. Não há `<SearchInput>` separado.

---

## Card

3 variants. Sempre sobre `surface` (white em light, `#1d1c17` em dark).

| Variant | Border | Hover | Uso |
|---------|--------|-------|-----|
| `data` | `1px solid border` | none | Containers estáticos (resumo de cliente, painel de stats) |
| `interactive` | `1px solid border` | `border-accent` + `translateY(-1px)` + `shadow-sm` | Cards clicáveis (kanban, dashboard tile) |
| `elevated` | none | none | Cards sobre fundos coloridos, modals internos |

Composição interna canônica:

```tsx
<Card>
  <CardHeader>
    <CardTitle>Pedido #12.443</CardTitle>          {/* h3 / 16px / 700 */}
    <CardActions><Button variant="ghost" /></CardActions>
  </CardHeader>
  <CardBody>...</CardBody>
  <CardFooter>...</CardFooter>
</Card>
```

Padding: `space-5` (20px) em Aerada. Radius: `radius-md` (12px).

---

## Badge

6 variants semânticos. Pill shape (`radius-full`), altura 22px, font-size 11.5–12px.

| Variant | bg | fg | Uso |
|---------|----|----|-----|
| `neutral` | `surface-elevated` | `text-muted` | Tag genérica, status default |
| `accent` | `accent-soft` (`#d9efe8`) | `accent` | Highlight não-semântico, "novo" |
| `success` | `success/14%` | `success` | Resolvido, Pago, Entregue |
| `warning` | `warning/14%` | `warning` | SLA próximo, Aguardando |
| `error` | `error/14%` | `error` | Vencido, Falhou, Cancelado |
| `info` | `info/14%` | `info` | Em revisão, Comentário interno |

Suporta dot (`<Badge variant="success" dot>Online</Badge>`) e ícone leading (`<Badge variant="warning"><Warning size={12} /> SLA</Badge>`).

---

## Avatar

4 tamanhos + grupo.

| Tamanho | px | Uso |
|---------|----|----|
| `sm` | 24 | Inline em row densa |
| `md` | 32 | **Default** — list item, comments |
| `lg` | 44 | Header de perfil, side-panel |
| `xl` | 64 | Hero de página de cliente |

Fallback: iniciais (2 chars max), font-weight 600. Bg `accent-soft`, fg `accent`. Border `1px border` pra separar do bg.

Status indicator opcional (`<Avatar status="online" />`): dot 10px no canto inferior-direito, cor `success`/`warning`/`text-muted`.

Group: `<AvatarGroup>` aplica `margin-left: -8px` em todos exceto o primeiro, criando overlap.

---

## Tabs

Underline-style (não pill, não box). Active = `accent` text + `border-bottom-color: accent` (2px).

```tsx
<Tabs defaultValue="open">
  <TabsList>
    <TabsTrigger value="open">Abertas <Badge>42</Badge></TabsTrigger>
    <TabsTrigger value="closed">Resolvidas</TabsTrigger>
  </TabsList>
  <TabsContent value="open">...</TabsContent>
</Tabs>
```

Padding 10px 16px por tab. Hover: `text` (sai do muted). Border-bottom da TabsList em `border-thin` para criar a "régua".

---

## Dialog (Modal)

Max-width 440px (default) ou 640px (`size="lg"`). Radius `lg` (16px). Backdrop `text/35%`. Animation: `fade-in` 200ms + `translateY(8px) scale(0.985) → 1` 320ms ease-spring.

Estrutura:

```tsx
<Dialog>
  <DialogTrigger asChild><Button>Abrir</Button></DialogTrigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Apagar conversa?</DialogTitle>
      <DialogDescription>Essa ação não pode ser desfeita.</DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <Button variant="ghost">Cancelar</Button>
      <Button variant="destructive">Apagar</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

---

## Sheet

Drawer lateral. Default direita, largura 480px. Animation: slide-in 320ms ease-spring. Usar para:
- Customer 360 (CRMSidePanel detail)
- Filtros avançados
- Edição rápida sem perder contexto da lista

Se a interação tem mais de 1 step ou exige foco total → use Dialog.

---

## Tooltip *(não instalado, próximo)*

Quando entrar: estilo dark sobre claro (text bg, fg bg-color). Delay 250ms. Font 11.5px. Não use pra texto longo (>40 chars) — vira `Popover`.

---

## Toast (Sonner)

Wrapper sobre `sonner`. Posição: top-right (canto direito superior). Animation slide-in 320ms ease-spring.

| Tipo | Cor | Ícone | Duração |
|------|-----|-------|---------|
| `success` | `success` | `CheckCircle` | 4s |
| `error` | `error` | `WarningOctagon` | 6s (mais tempo pra ler) |
| `info` | `info` | `Info` | 4s |
| `loading` | `text-muted` | `CircleNotch` (spin) | persistente até resolver |

Action button opcional (Desfazer): `<Toast action={{ label: 'Desfazer', onClick: ... }} />`.

---

## Skeleton

Bg shimmer linear-gradient `surface-elevated → accent-soft → surface-elevated`, animation 1.6s linear infinite. Radius `xs` default, ou matching do componente que substitui.

```tsx
<Skeleton className="h-4 w-32" />              {/* texto */}
<Skeleton className="h-9 w-24 rounded-xs" />   {/* botão */}
<Skeleton className="h-12 w-12 rounded-full" />{/* avatar */}
```

---

## Dropdown Menu

Radix dropdown. Bg `surface`, border `border-thin`, radius `sm`, shadow `md`. Items: padding 8px 12px, hover `accent-soft`, `accent` color em active.

Suporta separator (`<DropdownMenuSeparator>`), label (`<DropdownMenuLabel>`), submenu, checkbox e radio items.

---

## ScrollArea

Wrapper sobre Radix ScrollArea. Use SEMPRE em listas longas (inbox, kanban col). Scrollbar custom: 6px width, thumb `border` color, hover `text-muted`.

---

## Separator

`1px solid border`, margin vertical adaptativo (use em containers, não global). Vertical e horizontal disponíveis.

---

# Componentes custom SonghaiCRM

Componentes específicos do produto. Especificação detalhada em **Spec 04 §6** (`docs/specs/04-presentation.md`); resumo abaixo.

## ConversationItem

Item de lista do Inbox. Compõe Avatar + body (title/preview) + meta (timestamp + badge SLA).

```tsx
<ConversationItem
  conversation={conv}
  onSelect={onSelect}
  selected={isSelected}
/>
```

Estados: `default`, `unread` (peso 700 no title + dot accent), `selected` (bg `accent-soft`), `slaWarning` (badge warning), `slaExpired` (badge error). Truncate em title e preview.

## ChatThread

Container da thread de mensagens. ScrollArea por dentro, sticky header com Avatar + nome + status, footer com Composer.

## MessageBubble

Bubble de mensagem. 2 direções (`in` / `out`) + ack states.

| Direção | bg | fg | Radius |
|---------|----|----|--------|
| `in` (cliente) | `surface-elevated` | `text` | `12px` (corner inferior-esquerdo `4px`) |
| `out` (atendente) | `accent` | `accent-fg` | `12px` (corner inferior-direito `4px`) |

Max-width 70% do thread. Footer interno: timestamp tabular + ack icon (`Check`/`Checks`).

## KanbanCard (Pedido)

Card draggável (`cursor: grab`). Composição: title (Pedido #) + value (mono) + tags row + footer (owner Avatar + due date).

Hover: `border-accent` + `translateY(-1px)` + `shadow-sm`. Drag state: `cursor: grabbing`, `shadow-lg`, `rotate(1deg)` (sutil).

## CRMSidePanel (Customer 360)

Sheet lateral com info completa do cliente. Sections: Avatar grande + nome + status, Contact info, Métricas (LTV, n° pedidos), Conversas recentes, Pedidos recentes, Tags.

## StatusPill

Variante de Badge especializada para status de conversa/pedido. Sempre com dot leading. Cores mapeadas por estado:

- `aberta` → neutral
- `respondendo` → info
- `aguardando` → warning
- `resolvida` → success
- `cancelada` → text-muted (sem cor)

## OwnerAvatar

Avatar (sm/md) com tooltip mostrando nome do owner. Suporta "unassigned" (ícone `UserCircle` em text-muted). Click abre dropdown de reassign.

## TagPill

Badge especializada para tags livres (cliente VIP, frete-grátis, etc.). Cor neutra default; usuário pode escolher de palette restrita (5 stops do greige + accent). Suporta close button (`X` 12px) em modo editável.

---

# Composition rules

1. **Card encapsula uma unidade lógica.** Nunca aninhe Card em Card. Se precisa de seção interna, use `Separator` ou `CardSection`.
2. **Header > Body > Footer.** Sempre nessa ordem em Card e Dialog. Actions ficam em Header (canto direito) ou Footer (alinhamento right).
3. **Botão primary é raro.** 1 por view, idealmente 1 por seção. Se há 3 botões primary visíveis, repense hierarquia.
4. **Badge não compete com texto.** Use no máx 2 badges adjacentes; se mais, vira lista vertical.
5. **Modal não chama Modal.** Se um Dialog precisa abrir outro Dialog, repense fluxo (provavelmente é Sheet → Dialog ou wizard).
6. **Tooltip nunca contém ação.** Tooltip é informação read-only. Se precisa de ação, é Popover.
