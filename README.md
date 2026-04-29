# DeskcommCRM

> CRM operacional multi-tenant para e-commerce, com IA conversacional integrada nativamente, WhatsApp via WAHA e LGPD nativa.

**Status:** MVP em desenvolvimento (Fase 1 — 8–12 semanas)
**Modo atual:** BPO interno (operadora atende múltiplos tenants)
**Modo futuro:** SaaS direto pra lojistas

---

## Visão de Produto

DeskcommCRM unifica atendimento humano, chatbot com RAG por tenant, gestão de pedidos e pipeline de pós-venda numa única plataforma multi-tenant. Canal primário: WhatsApp (via WAHA). Multi-tenant desde o dia 1. LGPD nativa.

**Diferenciais:**

1. IA operando o atendimento com RAG por tenant (não chatbot decorativo).
2. E-commerce-native: vocabulário desenhado pro ciclo "Carrinho abandonado → Pago → Enviado → Entregue → Pós-venda".
3. MCP-ready (Fase 2).
4. LGPD nativa: webhooks `customer/redact` e `customer/data_request` da Nuvemshop como contrato de primeira-classe.

---

## Stack

| Camada | Escolha |
|---|---|
| Frontend | Next.js 15 App Router + TypeScript + Tailwind + shadcn/ui |
| Backend | Next.js Route Handlers (mesmo repo) |
| DB | Supabase (Postgres, RLS em toda tabela tenant-aware) |
| Realtime | Supabase Realtime |
| Auth | Supabase Auth via `@supabase/ssr` |
| Storage | Supabase Storage |
| WhatsApp | WAHA Plus (engine NOWEB) |
| Hospedagem app | Vercel |
| Validação | Zod |
| Rate limit | Upstash Redis |
| AI Gateway | Vercel AI Gateway (Anthropic primário, OpenAI backup) |
| Observability | Sentry |

---

## Quickstart 5 minutos

```bash
# 1. Clone + Node 20
nvm use            # ou instale Node 20+

# 2. Deps
pnpm install

# 3. Env
cp .env.example .env.local
# Preencher SUPABASE_*, WAHA_API_KEY, UPSTASH_*, SENTRY_DSN, etc.

# 4. WAHA local (opcional em dev sem WhatsApp)
docker compose up -d

# 5. Dev server
pnpm dev
```

App: <http://localhost:3000> · Health check: <http://localhost:3000/api/v1/health>

Login seed (após seed): `rafael@maudibrasil.com.br` / `DeskcommAdmin@2026`.

---

## Testes

```bash
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint
pnpm test:unit     # Vitest
pnpm test:e2e      # Playwright (requer dev server)
```

CI roda todos antes de merge. Teste de isolamento RLS é gate obrigatório.

---

## Estrutura

```
DeskcommCRM/
├── app/                    # Next.js App Router
│   ├── (admin)/            # Rotas super-admin
│   ├── (public)/           # Login, recovery
│   ├── app/                # Rotas autenticadas (inbox, kanban, contacts, audit, ...)
│   └── api/v1/             # API REST canônica
├── components/             # React (ui/, empty/, feedback/, shell/, ...)
├── lib/                    # supabase/, waha/, ai/, api/, logger.ts, env.ts
├── hooks/
├── supabase/migrations/    # SQL versionado
├── tests/{e2e,unit}/
├── scripts/
├── docs/                   # PRDs, specs, stories
└── tasks/
```

---

## Atalhos de teclado

- `Tab` / `Shift+Tab` — navegação focável (login, formulários, kanban cards)
- `Enter` — confirma ações primárias
- `Esc` — fecha dialogs/sheets

Documentação completa de keyboard shortcuts vem com EPIC-04 (kanban) e EPIC-03 (inbox).

---

## Documentação

- [`CLAUDE.md`](CLAUDE.md) — convenções não-negociáveis (leitura obrigatória pra contribuir)
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — visão de 1 página
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — fluxo PR + epic-executor
- [`docs/prd/`](docs/prd/) — PRDs
- [`docs/specs/`](docs/specs/) — specs técnicas
- [`docs/stories/epics/MASTER.md`](docs/stories/epics/MASTER.md) — plano de execução
- [`docs/DEPLOY-CHECKLIST.md`](docs/DEPLOY-CHECKLIST.md) — preflight pré-go-live

---

## Licença

Proprietária. Todos os direitos reservados a Rafael Melgaço / DeskcommCRM. Uso, cópia ou redistribuição requerem autorização escrita.
