---
title: Spec Técnica 12 — AI Agents UI (Telas, Fluxos, Wireframes)
parent: docs/research/pre-development/ai-agent-framework-deskcomm-whatsapp/09-handoff.md
depends_on: 09-spec-frontend-backend-integration.md, 10-spec-ai-agents-runtime.md, 11-spec-mcp-server-internal.md
related: 10-spec-ai-agents-runtime.md, 11-spec-mcp-server-internal.md
version: 0.1
status: draft (pre-implementation)
date: 2026-05-05
owner: Songhai, Lda
---

# Spec 12 — AI Agents UI (Telas, Fluxos, Wireframes)

> Mapa completo de telas, fluxos de navegação, wireframes ASCII, componentes shadcn, validação de formulário, estados de erro e interação com endpoints (Spec 10) e MCP catalog (Spec 11). Mantém o design system locked do projeto (Sage + Atkinson Hyperlegible + Aerada + Phosphor — ver memória `project_design_system_locked`).

---

## 1. Visão Geral

### 1.1 Mapa de telas

```
/ai/agents                          → Lista (entry point, no menu lateral)
   │
   ├─ /ai/agents/new                → Wizard de criação (mesma UI do edit, mas vazia)
   │
   ├─ /ai/agents/:id                → Detail (inclui aba Runs, aba Test, botões de ação)
   │     ├─ tab: configuration      → form de edição (cria nova versão draft no save)
   │     ├─ tab: test               → painel de dry-run com trace
   │     ├─ tab: runs               → log de execuções
   │     └─ tab: history            → versões anteriores
   │
   └─ /ai/credentials               → Gestão de provider keys (org-level)
```

### 1.2 Acessibilidade do menu

Adiciona item "Agentes IA" na sidebar principal, entre "Pipelines" e "Configurações", visível para `manager+`. Ícone Phosphor `Robot` ou `Brain`.

### 1.3 Stack UI

- Next.js 15 App Router, Server Components por default
- Forms: `react-hook-form` + Zod (mesmas schemas Spec 10)
- shadcn/ui new-york + custom Sage palette
- Server Actions para save/publish (não chama fetch direto do client)
- Realtime: Supabase channel `ai_agent_runs:org_id=eq.X` para atualizar log de runs ao vivo

---

## 2. Tela: `/ai/agents` (Lista)

### 2.1 Wireframe

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Agentes IA                                            [+ Novo agente]      │
│                                                                             │
│  Gerencie agentes que respondem mensagens WhatsApp automaticamente.         │
│                                                                             │
│  [🔍 Buscar nome...]   Status: [Todos ▾]   Sessão: [Todas ▾]                │
│                                                                             │
│  ┌─ Suporte Pré-venda ──────────────────────────────────── [⋯] Editar ──┐  │
│  │  🟢 Publicado v3 · Prioridade 10 · Sessão "Loja-1" · gpt-5-mini       │  │
│  │  Última execução: há 2 min · 142 runs hoje · $0.43                    │  │
│  │  Trigger: message · ignora grupos · keyword "preço|valor"             │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌─ Cobrança Pós-venda ─────────────────────────────────── [⋯] Editar ──┐  │
│  │  ⚪ Pausado · Última versão v2 · Sessão "Loja-1" · claude-haiku-4-5    │  │
│  │  Última execução: há 1 dia · 0 runs hoje · $0.00                      │  │
│  │  Trigger: message · horário 09:00-18:00                               │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌─ Captação Lead Quente ───────────────────────────────── [⋯] Editar ──┐  │
│  │  🟡 Rascunho v1 (nunca publicado) · Sessão não definida               │  │
│  │  ⚠ Configuração incompleta — finalize antes de publicar                │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Componentes

- `<AgentsList />` (Server Component) — fetch via `GET /api/v1/ai/agents` (organization_id do JWT)
- `<AgentCard />` por linha — Server Component
- `<AgentRowMenu />` (Client) — dropdown com Editar / Duplicar / Pausar/Despausar / Renomear / Arquivar
- `<AgentsListFilters />` (Client, useQueryState para URL persistence)

### 2.3 Estados

- **Vazio**: empty state com ilustração Sage + CTA "Crie seu primeiro agente"
- **Permissão insuficiente** (`viewer`): mostra lista read-only sem botão "+ Novo"
- **Erro 5xx**: card com retry button + Sentry-correlated request id

### 2.4 Ações do menu (⋯)

| Ação | Endpoint | Confirmação | Audit |
|---|---|---|---|
| Editar | navigate `/ai/agents/:id` | — | — |
| Duplicar | `POST /agents/:id:duplicate` | — | `ai_agent.duplicated` |
| Renomear | `PATCH /agents/:id` (modal inline) | — | `ai_agent.renamed` |
| Pausar | `POST /agents/:id:pause` | "Tem certeza? Agente para de responder" | `ai_agent.paused` |
| Despausar | `POST /agents/:id:publish` (republica versão atual) | — | `ai_agent.republished` |
| Arquivar | `DELETE /agents/:id` | "Esta ação é reversível por 30 dias" | `ai_agent.archived` |

---

## 3. Tela: `/ai/agents/:id` (Detail / Edit)

### 3.1 Header

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ← Agentes IA                                                                │
│                                                                             │
│  Suporte Pré-venda                       🟢 Publicado v3                    │
│  Última edição: há 5 min por Rafael      [Salvar rascunho]  [Publicar v4]   │
│                                                                             │
│ ┌──────────────────────────────────────────────────────────────────────────┐│
│ │ [Configuração] [Testar] [Execuções] [Histórico]                          ││
│ └──────────────────────────────────────────────────────────────────────────┘│
```

- "Salvar rascunho" cria nova versão `status='draft'` (sem afetar produção).
- "Publicar v4" só fica habilitado se há draft com diferenças vs versão publicada e validações passam.
- Indicador de status no header é um Badge:
  - 🟢 `published_version_id != null && draft inexistente` — só publicado
  - 🟡 `published_version_id != null && draft existente` — publicado + draft pendente ("v3 publicada, v4 em rascunho")
  - ⚪ `published_version_id == null` — pausado/nunca publicado
  - 🔴 versão tem invalidez (credential deletada, session offline) — bloqueia publish

### 3.2 Tab: Configuração (form principal)

Layout 2 colunas em desktop, stack em mobile.

```
┌─ Coluna esquerda ─────────────────────┬─ Coluna direita ─────────────────────┐
│                                       │                                      │
│ ## Identificação                      │ ## Provider & Modelo                 │
│                                       │                                      │
│ Nome do agente *                      │ Provider *                           │
│ [Suporte Pré-venda          ]         │ [Anthropic ▾]                        │
│                                       │                                      │
│ Descrição                             │ Modelo *                             │
│ [Tira dúvidas de catálogo  ]          │ [Claude Sonnet 4.6 ▾]                │
│                                       │ Janela 200k · $3/$15 por 1M tokens   │
│ Prioridade                            │                                      │
│ [10] (maior = roda primeiro)          │ Credencial (API key) *               │
│                                       │ [Produção (•••• abcd) ▾]             │
│ ## Prompt do sistema                  │  ↳ Validada · 8 modelos disponíveis  │
│                                       │ [+ Nova credencial]                  │
│ Você é um assistente da Loja X...     │                                      │
│ [textarea grande, monospace,          │ ## Limites                           │
│  contador de tokens em tempo real]    │                                      │
│                                       │ Passos máximos       [10] (1-25)     │
│ 📊 412 tokens estimados               │ Orçamento de tokens  [50000]         │
│                                       │ Orçamento de custo   [50] cents      │
│ ## Tools (MCP)                        │                                      │
│                                       │ ## WhatsApp                          │
│ Selecione as ferramentas que          │                                      │
│ este agente pode usar:                │ Sessão *                             │
│                                       │ [Loja-1 (5511...) ▾]                 │
│ 🔍 Leitura                            │  ↳ 🟢 working                        │
│ ☑ Buscar contatos                     │                                      │
│ ☑ Histórico de conversa               │ ## Gatilhos                          │
│ ☑ Listar pedidos do contato           │                                      │
│ ☐ Listar pipelines                    │ Eventos                              │
│                                       │ ☑ Mensagem recebida                  │
│ ✏️  Escrita                           │ ☐ Reação a mensagem                  │
│ ☐ Criar pedido                        │                                      │
│ ☐ Mover pedido de etapa               │ Filtros                              │
│ ☐ Atualizar pedido                    │ ☑ Ignorar grupos                     │
│                                       │ ☑ Ignorar mensagens minhas           │
│ 📞 Especiais                          │                                      │
│ ☑ Pedir atendente humano              │ Palavra-chave (regex)                │
│   (recomendado)                       │ [^!preço|valor          ]            │
│                                       │ ↳ Apenas mensagens que casam         │
│                                       │                                      │
│                                       │ Horário comercial                    │
│                                       │ ☑ Ativar                             │
│                                       │ Fuso [America/Sao_Paulo ▾]           │
│                                       │ De [09:00] Até [18:00]               │
│                                       │                                      │
│                                       │ ## Handoff                           │
│                                       │                                      │
│                                       │ ☑ Permitir agente pedir atendente    │
│                                       │   (via tool MCP)                     │
│                                       │                                      │
│                                       │ Palavras-chave de handoff direto     │
│                                       │ (bypassa LLM, vai direto para fila)  │
│                                       │ [chip] falar com humano [×]          │
│                                       │ [chip] atendente       [×]           │
│                                       │ [chip] pessoa real     [×]           │
│                                       │ [+ Adicionar]                        │
└───────────────────────────────────────┴──────────────────────────────────────┘
```

### 3.3 Validações de form (Zod, sincronizadas com Spec 10)

| Campo | Regra | Mensagem |
|---|---|---|
| name | min 1, max 100, único na org | "Nome obrigatório / Já existe" |
| priority | int 0-100 | "Prioridade entre 0 e 100" |
| system_prompt | min 10, max 50000 | "Prompt muito curto/longo" |
| provider | enum 3 valores | — |
| model | exists in `ai_models` para o provider | "Modelo indisponível" |
| credential_id | exists, is_active, validated, mesmo provider | "Credencial não validada / outro provider" |
| tool_ids | subset do catálogo MCP | "Tool desconhecida: X" |
| channel_session_id | exists, status='working' | "Sessão WhatsApp não está conectada" |
| max_steps | 1-25 | — |
| token_budget | 1000-500000 | — |
| cost_budget_cents | 1-10000 | — |
| keyword_regex | regex válida | "Regex inválida" (try/catch new RegExp) |
| business_hours | from < to | "Horário fim deve ser maior que início" |
| handoff_keywords | array, cada item min 2 chars | — |

### 3.4 Estados de save/publish

```
┌─ Estado: clean (versão atual igual à publicada) ─┐
│ [Salvar rascunho — desativado]                   │
│ [Publicar — desativado]                          │
│ "Sem alterações pendentes"                       │
└───────────────────────────────────────────────────┘

┌─ Estado: dirty (alteração não salva) ────────────┐
│ [Salvar rascunho]                                │
│ [Publicar — desativado, salve primeiro]          │
└───────────────────────────────────────────────────┘

┌─ Estado: draft saved (rascunho v4 salvo) ────────┐
│ [Salvar rascunho — desativado, sem mudanças]     │
│ [Publicar v4]                                    │
│ "Rascunho v4 salvo. Publique para ativar."       │
└───────────────────────────────────────────────────┘

┌─ Estado: invalid (validação falhou) ─────────────┐
│ [Publicar — desativado com tooltip do erro]      │
│ ⚠ Credencial Anthropic não validada              │
│ ⚠ Sessão WhatsApp offline                        │
└───────────────────────────────────────────────────┘
```

### 3.5 Modal "Publicar v4"

```
┌────────────────────────────────────────────────────────┐
│ Publicar v4 do agente "Suporte Pré-venda"?            │
│                                                        │
│ Mudanças vs v3 publicada:                              │
│  + Modelo: gpt-5-mini → claude-sonnet-4-6              │
│  + Tool adicionada: crm_create_lead                    │
│  + Prompt: 412 tokens (era 380)                        │
│                                                        │
│ Após publicar, v4 entra em produção imediatamente.     │
│ V3 vai pra histórico (recuperável).                    │
│                                                        │
│           [Cancelar]      [Confirmar publicação]       │
└────────────────────────────────────────────────────────┘
```

---

## 4. Tab: Testar

### 4.1 Wireframe

```
┌─ Testar agente (rascunho v4) ───────────────────────────────────────────────┐
│                                                                             │
│ Envie uma mensagem de exemplo. O agente roda em modo dry-run                │
│ — não envia ao WhatsApp do cliente.                                         │
│                                                                             │
│ Mensagem:                                                                   │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ Oi, qual o preço do tênis Nike Air Max 90?                              │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ Contato simulado (opcional):                                                │
│ Nome: [Cliente Teste     ]   Telefone: [+5511999999999]                    │
│                                                                             │
│                                              [Limpar]  [▶ Executar teste]   │
│                                                                             │
│ ─────────────────────────────────────────────────────────────────────────── │
│                                                                             │
│ ## Resultado (run #abc123 · concluído em 3.2s)                              │
│                                                                             │
│ 📊 Métricas: 1240 tokens in / 312 tokens out · $0.0042 · 3 passos           │
│                                                                             │
│ ▼ Trace de execução                                                         │
│                                                                             │
│ ① 12:34:01.412  → LLM (claude-sonnet-4-6)                                   │
│    ⤷ tool_call: crm_search_contacts({ query: "+5511999999999" })           │
│       ✓ 1 contato (Cliente Teste, criado agora)                            │
│                                                                             │
│ ② 12:34:01.834  → LLM                                                       │
│    ⤷ tool_call: crm_get_conversation_history({ conversation_id: "..." })   │
│       ✓ 0 mensagens anteriores                                              │
│                                                                             │
│ ③ 12:34:02.456  → LLM                                                       │
│    ⤷ resposta final (sem tool):                                             │
│       "Olá! O Nike Air Max 90 está R$ 549,90 com 10% off no Pix..."        │
│                                                                             │
│ 📨 Mensagem que SERIA enviada:                                              │
│    Para: +5511999999999 (sessão Loja-1)                                     │
│    "Olá! O Nike Air Max 90 está R$ 549,90 com 10% off no Pix..."           │
│                                                                             │
│    [📋 Copiar resposta]                                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Comportamento

- **Botão "Executar teste"** chama `POST /api/v1/ai/agents/:id/versions/:vid:test` com a versão **draft mais recente** (não a publicada — esse é o ponto: testar ANTES de publicar).
- Resposta vem como uma `ai_agent_runs` row com `is_dry_run=true`.
- Trace renderizada com `<RunTrace />` component — collapse por step, sintaxe highlighting nos JSON args/results.
- Custo do dry-run **conta no budget mensal do tenant** (warning visível: "Este teste consome créditos reais do provider").
- Limite: 5 tests por minuto por agente (rate limit anti-loop UX).

---

## 5. Tab: Execuções

### 5.1 Wireframe

```
┌─ Execuções do agente ───────────────────────────────────────────────────────┐
│                                                                             │
│ [Hoje ▾]   Status: [Todos ▾]   [⟳ Atualizar]                                │
│                                                                             │
│ Métricas hoje: 142 runs · 138 sucesso · 2 handoff · 2 falha · $0.43         │
│                                                                             │
│ Tempo            Conversa         Status      Steps   Tokens     Custo      │
│ ─────────────────────────────────────────────────────────────────────────── │
│ 12:34:02 (3s)    +5511...9876     ✓ ok        3       1552       $0.0042   │
│ 12:33:48 (2s)    +5511...8432     ⤴ handoff   1       0          $0.0001   │
│ 12:31:15 (5s)    +5511...1122     ✓ ok        4       2034       $0.0058   │
│ 12:28:02 (timeout) +5511...3344   ✗ aborted   10      48000      $0.1340   │
│   ⚠ token_budget_exceeded                                                   │
│ ...                                                                         │
│                                                          [Carregar mais]    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Detalhe (drawer ao clicar na linha)

Drawer lateral com mesma trace UI da Tab Testar, mais:
- Link "Ver conversa" → navega para `/conversations/:id` com mensagem destacada
- Link "Ver inbound original" → drawer da mensagem
- Botão "Reportar problema" → abre modal de feedback ligado ao `run_id`

### 5.3 Realtime

- Supabase channel `ai_agent_runs:agent_id=eq.X` → toast quando novo run completa: "Nova execução: ✓ 3.2s"
- Tabela atualiza top-to-bottom sem scroll loss

---

## 6. Tab: Histórico de versões

### 6.1 Wireframe

```
┌─ Versões deste agente ──────────────────────────────────────────────────────┐
│                                                                             │
│ ● v4   Rascunho atual          editado há 5 min                  [Editar]   │
│ ●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●│
│ ✓ v3   Publicada               desde 2026-04-30          [Diff vs v4][Reverter]│
│ ──     v2   Substituída              em 2026-04-22                    [Diff]│
│ ──     v1   Substituída              em 2026-04-15                    [Diff]│
└─────────────────────────────────────────────────────────────────────────────┘
```

- Diff mostra system_prompt em side-by-side (react-diff-viewer), tools como add/remove chips, mudanças de provider/model/limits em tabela.
- "Reverter" cria uma nova versão v5 idêntica à v3 e a publica (não republica diretamente — preserva ordem de versão).

---

## 7. Tela: `/ai/credentials`

### 7.1 Wireframe

```
┌─ Credenciais de IA (org-level) ─────────────────────────────────────────────┐
│                                                                             │
│ Adicione suas chaves de API dos provedores. Elas são cifradas               │
│ e usadas apenas para chamadas de agentes desta organização.                 │
│                                                                             │
│                                                  [+ Adicionar credencial]   │
│                                                                             │
│ ┌─ Anthropic ─────────────────────────────────────────────────────────────┐ │
│ │ Produção         •••• abcd       ✓ Validada (há 2h)         [Excluir]   │ │
│ │   ↳ usada em: Suporte Pré-venda, Cobrança Pós-venda                     │ │
│ │                                                                         │ │
│ │ Sandbox          •••• xyz9       ✓ Validada (há 5d)         [Excluir]   │ │
│ │   ↳ não usada por nenhum agente                                         │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ ┌─ OpenAI ────────────────────────────────────────────────────────────────┐ │
│ │ Sem credenciais cadastradas. [+ Adicionar OpenAI]                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ ┌─ Google ────────────────────────────────────────────────────────────────┐ │
│ │ Sem credenciais cadastradas. [+ Adicionar Google]                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 7.2 Modal "Adicionar credencial"

```
┌─────────────────────────────────────────────────────────┐
│ Nova credencial                                         │
│                                                         │
│ Provider                                                │
│ ( ) Anthropic    (•) OpenAI    ( ) Google              │
│                                                         │
│ Rótulo                                                  │
│ [Produção                                ]              │
│   ↳ usado para identificar nas configurações            │
│                                                         │
│ API key                                                 │
│ [sk-proj-•••••••••••••••••••••••••••••••••]            │
│   ↳ obtida em platform.openai.com/api-keys              │
│   ↳ permissão mínima: model:read, model:invoke          │
│                                                         │
│ ⚠ Será armazenada cifrada. Não conseguiremos mostrar    │
│ a key novamente após salvar.                            │
│                                                         │
│              [Cancelar]    [Salvar e validar]           │
└─────────────────────────────────────────────────────────┘
```

- "Salvar e validar" → POST `/api/v1/ai/credentials`. Toast: "Credencial salva. Validando..."
- Após validação async (1-3s): toast verde "Validada — 8 modelos disponíveis" OU vermelho "Erro: Invalid API key"
- Se falhou, credencial fica `is_active=true` mas `validated_at=null`. UI bloqueia uso até revalidar.

### 7.3 Excluir credencial

- Bloqueio: se `credential_id` está em uso por alguma `ai_agent_versions` publicada → erro 409 "Em uso por X agentes. Substitua antes de excluir."
- Modal de confirmação destacando consequência.

---

## 8. Componentes compartilhados

| Componente | Path | Responsabilidade |
|---|---|---|
| `<AgentStatusBadge />` | `app/(app)/ai/agents/_components/` | Render do estado (published/draft/paused/invalid) |
| `<AgentCard />` | idem | Linha da lista |
| `<AgentForm />` | idem | Form principal (configuração) |
| `<ToolPicker />` | idem | Checklist de MCP tools, agrupado por categoria |
| `<ModelPicker />` | idem | Dropdown provider + modelo, com preço |
| `<CredentialPicker />` | idem | Dropdown de credenciais filtrado por provider |
| `<TriggerEditor />` | idem | UI de filtros (eventos, regex, horário) |
| `<RunTrace />` | idem | Render JSON da trace passo-a-passo |
| `<RunsTable />` | idem | Tabela de runs com realtime |
| `<VersionDiff />` | idem | Diff side-by-side de versões |
| `<HandoffKeywordsInput />` | idem | Chips input para keywords |
| `<TokenCounter />` | `lib/ui/` | Contador de tokens reativo (gpt-tokenizer no client) |

---

## 9. Server Actions

```ts
// app/(app)/ai/agents/_actions.ts

'use server'

export async function saveAgentDraftAction(agentId: string, formData: FormData) {
  // 1. Parse via Zod (mesmo schema do POST /versions)
  // 2. POST /api/v1/ai/agents/:id/versions internamente
  // 3. revalidatePath('/ai/agents/[id]')
  // 4. return { ok, version_id, errors? }
}

export async function publishAgentAction(agentId: string, versionId: string) {
  // 1. POST /api/v1/ai/agents/:id:publish
  // 2. revalidatePath('/ai/agents')
  // 3. revalidatePath('/ai/agents/[id]')
  // 4. return { ok, errors? }
}

export async function testAgentAction(agentId: string, versionId: string, message: string) {
  // 1. POST /api/v1/ai/agents/:id/versions/:vid:test
  // 2. return run object (com trace completa)
}

// ... duplicate, pause, archive, rename, addCredential, deleteCredential
```

---

## 10. Fluxos críticos (sequence)

### 10.1 Criar primeiro agente (usuário novo)

```
User                  UI                    API                     DB
 │                     │                     │                      │
 │ /ai/agents          │                     │                      │
 │────────────────────>│                     │                      │
 │                     │ GET /agents         │                      │
 │                     │────────────────────>│                      │
 │                     │                     │ select published+draft│
 │                     │                     │─────────────────────>│
 │                     │ empty list          │                      │
 │                     │<────────────────────│                      │
 │ "+ Novo agente"     │                     │                      │
 │────────────────────>│                     │                      │
 │                     │ /ai/agents/new      │                      │
 │                     │ load picker data:   │                      │
 │                     │  - GET /providers   │                      │
 │                     │  - GET /credentials │                      │
 │                     │  - GET /channel-sess│                      │
 │                     │  - GET /mcp/tools   │                      │
 │ preenche form       │                     │                      │
 │ (precisa de creds)  │                     │                      │
 │ "+ Nova credencial" │                     │                      │
 │────────────────────>│ modal               │                      │
 │ cola key            │                     │                      │
 │ "Salvar e validar"  │                     │                      │
 │────────────────────>│ POST /credentials   │                      │
 │                     │────────────────────>│ encrypt+insert       │
 │                     │                     │─────────────────────>│
 │                     │ 201 + valid async   │                      │
 │                     │<────────────────────│ ping provider        │
 │                     │                     │ /v1/models           │
 │                     │                     │ update validated_at  │
 │                     │                     │─────────────────────>│
 │ continua form       │                     │                      │
 │ "Salvar rascunho"   │                     │                      │
 │────────────────────>│ saveAgentDraftAction│                      │
 │                     │ POST /agents (cria) │                      │
 │                     │────────────────────>│ insert agent+version │
 │                     │                     │─────────────────────>│
 │                     │ 201                 │                      │
 │                     │<────────────────────│                      │
 │ redirect /:id       │                     │                      │
 │ → tab Testar        │                     │                      │
 │ envia sample msg    │                     │                      │
 │────────────────────>│ testAgentAction     │                      │
 │                     │ POST /test          │                      │
 │                     │────────────────────>│ run agent loop       │
 │                     │                     │ (Spec 10 §6)         │
 │                     │ trace + final text  │                      │
 │                     │<────────────────────│                      │
 │ vê resultado, OK    │                     │                      │
 │ "Publicar v1"       │                     │                      │
 │────────────────────>│ publishAgentAction  │                      │
 │                     │ POST /:publish      │                      │
 │                     │────────────────────>│ atomic version flip  │
 │                     │                     │ event_log emit       │
 │                     │                     │─────────────────────>│
 │ Badge: 🟢 Publicado │                     │                      │
 │<────────────────────│                     │                      │
```

### 10.2 Mensagem WhatsApp recebida → agente responde

```
Cliente WhatsApp     WAHA           Webhook handler   event_log    Dispatcher cron   /agents/run    AI Gateway   MCP Server   Supabase     WAHA
   │                  │                  │                │              │                │              │             │             │           │
   │ "Quanto é X?"    │                  │                │              │                │              │             │             │           │
   │─────────────────>│                  │                │              │                │              │             │             │           │
   │                  │ POST /webhooks   │                │              │                │              │             │             │           │
   │                  │─────────────────>│                │              │                │              │             │             │           │
   │                  │                  │ HMAC verify    │              │                │              │             │             │           │
   │                  │                  │ insert message │              │                │              │             │             │           │
   │                  │                  │───────────────────────────────────────────────────────────────────────────────────────────>│           │
   │                  │                  │ insert event_log dispatch     │                │              │             │             │           │
   │                  │                  │───────────────────────────────────────────────>│              │             │             │           │
   │                  │ 200 OK           │                │              │                │              │             │             │           │
   │                  │<─────────────────│                │              │                │              │             │             │           │
   │                  │                  │                │              │ pull events    │              │             │             │           │
   │                  │                  │                │              │ match agent    │              │             │             │           │
   │                  │                  │                │              │ check budget   │              │             │             │           │
   │                  │                  │                │              │ insert run     │              │             │             │           │
   │                  │                  │                │              │ POST run       │              │             │             │           │
   │                  │                  │                │              │───────────────>│              │             │             │           │
   │                  │                  │                │              │                │ load version │             │             │           │
   │                  │                  │                │              │                │ decrypt key  │             │             │           │
   │                  │                  │                │              │                │ history+inbound mcp tools │             │             │           │
   │                  │                  │                │              │                │ generate     │             │             │           │
   │                  │                  │                │              │                │─────────────>│             │             │           │
   │                  │                  │                │              │                │              │ tool_call   │             │           │
   │                  │                  │                │              │                │<─────────────│             │             │           │
   │                  │                  │                │              │                │ exec tool    │             │             │           │
   │                  │                  │                │              │                │─────────────────────────────>│           │             │           │
   │                  │                  │                │              │                │              │             │ supabase q  │           │
   │                  │                  │                │              │                │              │             │────────────>│           │
   │                  │                  │                │              │                │              │ result      │             │           │
   │                  │                  │                │              │                │<─────────────────────────────│           │             │           │
   │                  │                  │                │              │                │ generate (final)            │             │           │
   │                  │                  │                │              │                │─────────────>│             │             │           │
   │                  │                  │                │              │                │ "R$ 549,90"  │             │             │           │
   │                  │                  │                │              │                │<─────────────│             │             │           │
   │                  │                  │                │              │                │ sendText                                            ││
   │                  │                  │                │              │                │──────────────────────────────────────────────────────>│
   │                  │ relay to client  │                │              │                │                                                      │
   │ "R$ 549,90"      │<─────────────────│                │              │                │ update run completed                                 │
   │<─────────────────│                  │                │              │                │ insert outbound message                              │
   │                  │                  │                │              │                │ event run_completed                                  │
```

### 10.3 Handoff por keyword (bypassa LLM)

```
... mesma sequência até entrar no /agents/run ...
                                               │ load version
                                               │ check inbound vs handoff_keywords
                                               │ MATCH "falar com humano"
                                               │ skip LLM, call finalizeHandoff
                                               │ → assign conversation to user
                                               │ → run.status = 'handoff'
                                               │ → event handoff_triggered
                                               │ → no WAHA send (or canned message
                                               │    "Conectando com atendente...")
```

---

## 11. Acessibilidade & i18n

- Todos labels em PT-BR (regra do projeto)
- Atkinson Hyperlegible já é dyslexia-friendly
- ARIA labels em badges de status
- Trace expansível navegável por teclado (Tab/Shift+Tab + Enter)
- Toasts com ARIA live region
- Forms longos: skip-link "Pular para botões de ação"

---

## 12. Telemetria de UI

- `ai_agent.create_started` (clicked "+ Novo")
- `ai_agent.draft_saved` (Server Action)
- `ai_agent.published` (Server Action)
- `ai_agent.tested` (Server Action)
- `ai_agent.config_validation_failed` (Zod errors)
- `ai_credential.added` (modal salvou)

Todos via `/api/v1/audit` ou já capturados pelas Server Actions emitindo audit log.

---

## 13. Performance

- Lista paginada (default 25/page) com cursor base64+HMAC (Spec 09)
- Realtime apenas na tab Runs (subscribe quando aberta, unsubscribe ao trocar)
- Token counter no client (gpt-tokenizer ~30kb gzip) — debounce 200ms
- Save / Publish: skeleton durante a Server Action; otimista para campos rápidos (rename), pessimista para mudanças com side effects (publish)

---

## 14. Definition of Done (UI)

1. 3 telas implementadas: lista, detail (4 tabs), credentials
2. Todas validações Zod sincronizadas com Spec 10
3. Server Actions para todos botões com side effect
4. Realtime na tab Runs
5. Diff de versões funcional
6. Test mode renderiza trace clicável passo-a-passo
7. Empty states + erros 4xx/5xx tratados
8. RBAC respeitado (viewer vê read-only, manager full-read, admin write)
9. Token counter live no system prompt
10. Modal de exclusão de credential bloqueia se em uso
11. Skeleton/loading states em todas as telas
12. Mobile: forms colapsam para single column < 768px
13. Audit log entries aparecem ao publicar / arquivar

---

## 15. Cross-references

- Spec 10 — endpoints + schema que esta UI consome
- Spec 11 — catálogo MCP que popula o ToolPicker
- Spec 09 — frontend-backend integration (cursor, request id, error handling)
- Memory `project_design_system_locked` — Sage + Atkinson + Aerada
