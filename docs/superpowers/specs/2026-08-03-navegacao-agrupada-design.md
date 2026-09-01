# Navegação agrupada — design

> Data: 2026-08-03 · Branch: `feat/navegacao-agrupada` (base `origin/main` @ `5a8f4a7`)
> Origem: o usuário descobriu por acaso que "Funis" existia, enterrado em Configurações.

---

## 1. O problema, medido

O sistema tem **~30 telas navegáveis**. O sidebar mostra 17, numa lista plana sem hierarquia. As demais estão espalhadas em **três sistemas de navegação que não conversam entre si**:

| Superfície | Arquivo | Telas | Defeito |
|---|---|---|---|
| Sidebar | `components/shell/Sidebar.tsx` → `NAV_ITEMS` | 17 | lista plana: "Memória da IA" tem o mesmo peso visual que "Inbox" |
| Hub de Configurações | `app/app/settings/page.tsx` → `LINKS` | 9 | mistura conta pessoal (Perfil, Segurança) com desenho do negócio (**Funis**) |
| Abas de IA | `app/app/ai/_components/AiSectionTabs.tsx` → `TABS` | 6 | só renderizam dentro de `/app/ai/*` — invisíveis para quem não está lá |

As três listas são **escritas à mão, em arquivos separados, sem fonte comum**. Consequências verificadas em código:

- **`/app/ai/knowledge/sources`** — a base de conhecimento do RAG, o coração dos agentes — só existe como aba dentro de Agentes IA. Não está no sidebar nem no hub.
- **`/app/ai/credentials`**, **`/app/ai/usage`**, **`/app/ai/cases`**, **`/app/ai/inbox`** — mesma condição.
- **`/app/integrations/nuvemshop`** — **zero links no app inteiro**. Só se chega digitando a URL.
- **`/app/audit`** — acessível apenas por um card em Configurações.
- **A busca ⌘K do topo não faz nada.** `components/shell/SearchTrigger.tsx:9` é um `console.info` com o comentário `"UI not yet implemented"`. A única saída de emergência para descoberta é uma promessa vazia.

A área de IA sozinha tem **11 telas** repartidas entre sidebar (6) e abas (6), com uma sobreposição e **nenhum lugar que mostre as 11 juntas**.

---

## 2. Causa raiz

O `CLAUDE.md` já traz o Living System Checklist no Definition of Done, e ele pergunta **"Onde eu apareço na tela?"**. Todas essas features responderam *"sim, tenho tela"* e passaram no gate.

Nenhuma foi obrigada a responder **"e como se chega nela sem saber a URL?"**.

A feature tem tela. A tela não tem porta. O checklist não pede a porta — e nada no CI cobra.

`docs/doctrine/sistema-vivo.md:111` previu exatamente este momento: enforcement mecânico entraria *"só se a doutrina começar a vazar na prática"*. Onze telas sem porta é o vazamento.

---

## 3. Decisões tomadas

| # | Decisão | Quem decidiu |
|---|---|---|
| D1 | Sidebar **híbrido**: grupos rotulados com o uso diário + página-hub por grupo grande | usuário |
| D2 | Base: **branch nova de `origin/main`, worktree próprio** (`~/SonghaiCRM-nav`) | usuário |
| D3 | IA no sidebar: **Agentes → Follow-ups → Roteadores**, nessa ordem de uso | usuário |
| D4 | **Evolução da IA sai do grupo de IA** e vai para Análise — é observabilidade do sistema, não configuração do agente | usuário |
| D5 | Hub precisa ser **organizado por jornada**, não uma grade de cards | usuário |
| D6 | Escopo: registro + nav + hubs + redirects + teste de enforcement + doutrina + **⌘K vivo** | usuário |
| D7 | Hub só existe onde o grupo passa de 4 telas; grupos menores ficam 100% no sidebar | assistente |
| D8 | `permission: string` → **`minRole`**, alinhado à guarda server-side real das páginas | assistente |

**D4 é um critério, não um item.** *Configurar o sistema* e *observar o sistema funcionando* são atividades diferentes e pertencem a grupos diferentes. Vale para toda tela futura.

---

## 4. Arquitetura: um registro, várias projeções

Fonte única em `lib/navigation/registry.ts`. Sidebar, hubs e ⌘K deixam de manter listas próprias e passam a **derivar** dela.

```ts
export type NavGroupId =
  | "atendimento" | "crm" | "ia" | "canais" | "analise" | "organizacao";

export interface NavDestination {
  href: string;
  label: string;
  description: string;    // usado no hub e como texto buscável no ⌘K
  icon: PhosphorIcon;
  group: NavGroupId;
  section?: string;       // sub-seção dentro do hub — ex.: "Montar o agente"
  minRole?: Role;         // default: viewer (todos veem)
  sidebar?: boolean;      // default: false — só o uso diário sobe
  healthDot?: boolean;
}

export interface NavGroup {
  id: NavGroupId;
  label: string;
  hub?: string;           // href do hub, quando o grupo tem um
}
```

Três projeções puras do mesmo array:

- **Sidebar** — filtra `sidebar === true`, agrupa por `group`, injeta o link do hub quando existe.
- **Hub** — filtra por `group`, agrupa por `section`, renderiza label + description.
- **⌘K** — todos os destinos, busca em `label + description`.

**Sidebar e hub mostrarem a mesma tela não é a duplicação que estamos consertando.** Hoje as listas divergem porque são três arquivos escritos à mão; com o registro são duas *vistas* do mesmo dado. Tela nova aparece nas duas sem ninguém editar dois arquivos.

### 4.1 Efeito colateral: o if-chain de permissões morre

O `Sidebar.tsx` atual chama **sete** `usePermission()` hardcoded (linhas 44-50) e um `if`-chain de sete ramos no filtro (86-94) — porque hooks não podem ser chamados em laço condicional.

Como o registro declara `minRole` (§4.2) em vez de uma string de ação, o filtro vira uma função pura no próprio registro:

```ts
export function canSee(d: NavDestination, isPlatformAdmin: boolean, role: Role | null): boolean;
```

Sete hooks e sete ramos saem; um `useAuth()` e um `.filter()` entram.

> **Decidido na implementação:** não mexer no `AuthProvider`. A versão anterior deste spec previa extrair `hasMinRole()` de lá, mas isso era o *meio*, não o fim — `canSee` no registro atinge o mesmo resultado tocando um arquivo a menos. `usePermission` segue intacto, servindo as ações granulares (`ai.agents.write` etc.), que não são navegação.

### 4.2 Por que `minRole` e não `permission`

As páginas guardam com `ROLE_RANK` direto no server, não via `ACTION_MIN_ROLE`. Guardas reais medidas:

| Tela | Guarda na página |
|---|---|
| `ai/knowledge/sources` | manager |
| `ai/usage` | manager (admin p/ orçamento) |
| `ai/cases`, `ai/inbox` | agent |
| `ai/credentials` | manager (admin p/ escrever) |
| `audit` | manager |
| `settings/tenant/pipelines` | manager (admin p/ escrever) |
| `integrations/nuvemshop` | **nenhuma na página**; Server Actions exigem admin |

`minRole` no registro espelha a guarda real e evita o pior bug de navegação: **link visível que leva a redirect**.

> **Nota sobre a Nuvemshop.** A página não filtra por role, mas `connectNuvemshop.ts:30` e `disconnectNuvemshop.ts:27` bloqueiam quem não é admin. É UI ruim, não falha de autorização — promovê-la ao sidebar não expõe nada. Registro declara `minRole: "admin"` para não mostrar a um viewer uma tela cujos botões falham.

---

## 5. Os grupos

```
ATENDIMENTO
   Inbox
   Radar
   Respostas rápidas        ← renomeado (hoje "Templates")
CRM
   Kanban
   Contatos
   Funis                    ← sobe de Configurações
AGENTE DE IA
   Agentes
   Follow-ups
   Roteadores
   Ver tudo em IA  →
CANAIS
   Conexões
   Nuvemshop                ← era órfã total
   Webhooks
ANÁLISE
   Desempenho
   Evolução da IA           ← D4: observabilidade, não configuração
   Audit Log                ← sobe de Configurações
ORGANIZAÇÃO
   Equipe
   Configurações   →
```

> **Corrigido na implementação (2026-08-03), depois de medir na tela.** Esta divisão não cabia: em 1280×768 o conteúdo dava **1019px contra 663px visíveis** — sete links e os grupos Análise e Organização fora da dobra; em 1080px, Configurações ainda ficava fora. Era trocar "17 itens sem hierarquia" por "20 itens que não cabem". Duas mudanças resolveram, ambas aplicando regras que já estavam neste spec e não foram aplicadas:
>
> 1. **Canais (5 telas) ganhou hub** em `/app/canais` — a regra "hub a partir de 5 telas" valia e foi ignorada. Sidebar fica com Conexões e Canal oficial; Templates Meta, Nuvemshop e Webhooks vivem no hub (uso raro: configura-se uma vez). Equipe idem, no hub de Configurações.
> 2. **Configurações saiu da área rolável para o rodapé fixo** do sidebar. É o item mais procurado por quem não achou algo; deixá-lo dependendo de scroll recriaria o problema. Constante `GRUPO_NO_RODAPE` no registro.
>
> Medido depois: **768px** → 715px de conteúdo, nenhum grupo fora da dobra; **900px e 1080px** → não rola. A medição virou teste de não-regressão em `tests/e2e/navegacao.spec.ts`.

**"ANÁLISE", não "Observabilidade"** — a palavra é de engenheiro, e quem instala isto numa VPS é dono de PME.

### 5.1 A colisão de nomes em "Templates"

`/app/templates` **não** é template do WhatsApp oficial. É *"scripts salvos para responder mais rápido, pessoais ou compartilhados com a equipe"* (`app/app/templates/page.tsx:20`), consumido pelo `components/inbox/Composer.tsx`. É ferramenta de **atendimento**.

O PR #105 traz um *segundo* "Templates" — esse sim o da Meta (HSM), como sub-aba de Conexões. Duas telas com o mesmo nome e propósitos opostos.

Resolução: `/app/templates` vira **"Respostas rápidas"**. O nome "Templates" fica livre para o da Meta, onde ele é o termo técnico correto.

---

## 6. Os hubs, por jornada (D5)

### `/app/ai` — Agente de IA

| Etapa | Telas | Pergunta que responde |
|---|---|---|
| **Montar o agente** | Agentes · Roteadores · Follow-ups · Credenciais | quem atende, com que instrução, e quem pega qual conversa |
| **Ensinar o agente** | Conhecimento · Memória · Skills | o que ele sabe e o que consegue fazer |
| **Acompanhar o agente** | Casos · Alertas · Uso e orçamento | o que ele fez e quanto custou |

"Propostas" **não** entra: não é tela, é aba dentro de cada agente (`AgentTabs.tsx:76`) — já está no lugar certo.

### `/app/settings` — Organização

| Seção | Telas |
|---|---|
| **Sua conta** | Perfil · Segurança · Notificações |
| **Sua empresa** | Organização · Equipe · Billing |
| **Dados e acesso** | LGPD · API Tokens |

Os cards duplicados de hoje (Conexões, Audit Log) saem — passaram para Canais e Análise.

`AiSectionTabs.tsx` é **removido**: o hub o substitui, e ele era a causa das seis telas invisíveis.

---

## 7. Rotas antigas: nenhuma muda

**Nenhum arquivo sai do lugar. Nenhum redirect é criado.** Só a navegação muda.

`/app/settings/tenant/pipelines` continua nessa URL mesmo aparecendo no grupo CRM. O path passa a discordar do agrupamento — mas a URL não é o que o usuário estava procurando quando não achou os Funis; ele estava procurando uma **porta**. Mover arquivo e criar redirect é trabalho que não resolve nada do que foi pedido, e cada rota renomeada é um redirect a manter para sempre.

Idem `/app/templates`: só o label vira "Respostas rápidas".

> Se algum dia a URL confundir alguém de verdade (suporte, tutorial, link colado), aí sim: mover + redirect permanente. Não antes.

---

## 8. ⌘K — a busca que hoje não existe

`SearchTrigger.tsx` passa a abrir uma paleta que busca em `label + description` do registro e navega no Enter.

**Sem `cmdk`.** A dependência não está instalada, e `components/ui/` já tem `dialog`, `input` e `scroll-area`. Paleta = Dialog + Input + lista filtrada + ↑↓/Enter: ~60 linhas, zero dependência nova.

Escopo v1: **só navegação**. Não busca contatos, conversas nem leads — isso é outra feature, com outra fonte de dados.

---

## 9. Enforcement — para a bagunça não voltar

### 9.1 O teste

`tests/unit/navegacao-completude.test.ts` — estático, sem Postgres, roda no job `verify` do CI:

1. Varre `app/app/**/page.tsx` e deriva a rota de cada uma.
2. Ignora segmentos dinâmicos (`[id]`) e o que estiver em `NAV_ALLOWLIST` (redirects legados, telas de detalhe).
3. **Falha se uma rota não estiver no registro nem na allowlist** → tela sem porta.
4. **Falha se uma entrada do registro apontar para `page.tsx` inexistente** → link morto.

A allowlist é explícita e comentada: excluir uma tela vira uma decisão registrada, não um esquecimento.

### 9.2 A doutrina

Uma linha nova no Living System Checklist (`docs/doctrine/sistema-vivo.md` + DoD do `CLAUDE.md`):

```
[ ] Por qual porta se chega até mim?  (entrada no registro de navegação, ou allowlist justificada)
```

E as regras que o registro materializa, para features futuras:

- **Todo destino declara seu grupo.** Sem grupo, sem merge.
- **Configuração e observabilidade são grupos diferentes** (D4).
- **Hub a partir de 5 telas.** Abaixo disso, o grupo cabe inteiro no sidebar — hub de 3 itens é um clique a mais para chegar onde já dava.
- **Sidebar carrega o uso diário; o hub carrega o inventário.** Na dúvida, `sidebar: false` — o hub e o ⌘K já garantem a descoberta.

---

## 10. Fora de escopo (YAGNI declarado)

- **Busca de conteúdo no ⌘K** (contatos, conversas, leads) — outra fonte de dados, outra feature.
- **Badge de pendência no LGPD** — some do sidebar; se virar problema real, um badge resolve melhor que uma linha morta ocupando espaço.
- **Nav dirigida por estado** (esconder IA se não há agente) — esconder é o oposto do problema que estamos resolvendo.
- **Verificar estaticamente `minRole` do registro contra a guarda da página** — exigiria parsear cada page. Bom rung futuro se aparecer divergência na prática.

---

## 11. Riscos

| Risco | Tratamento |
|---|---|
| **PR #105 aberto no mesmo território** (`feat/canais-oficial`, "Conectar canal deixa de estar em três lugares") | Ele **não toca `Sidebar.tsx`** — `NAV_ITEMS` é idêntico. Colide só em `settings/page.tsx`, que eu reescrevo. Merge semântico simples: o card-ponte dele vira entrada do registro com `group: "canais"`. |
| Usuário treinado no lugar antigo não acha mais | Nenhuma URL muda (seção 7), então todo link salvo e print de tutorial continua válido. O ⌘K vira a rede de segurança para quem procurar pelo nome. |
| Grupo de IA ficar grande de novo | Regra "hub a partir de 5 telas" + o teste, que força a declaração de grupo |

---

## 12. Critérios de aceite

1. `lib/navigation/registry.ts` é a única lista de destinos; `NAV_ITEMS`, `LINKS` e `TABS` deixam de existir.
2. Sidebar renderiza 6 grupos rotulados na ordem da seção 5, com filtro por `minRole`.
3. `/app/ai` e `/app/settings` renderizam hubs seccionados por jornada (seção 6).
4. Nenhuma das telas antes invisíveis segue invisível: Conhecimento, Credenciais, Uso, Casos, Alertas, Nuvemshop e Audit Log alcançáveis pela navegação.
5. ⌘K abre, filtra por texto e navega.
6. `navegacao-completude.test.ts` passa — e **falha** se eu remover uma entrada do registro (prova de que o teste morde).
7. `pnpm typecheck` e `pnpm lint` zerados.
8. **Provado pela tela**, em ambiente fresco estilo VPS, com evidência visual — DoD item 12. `curl` não conta.
9. Living System Checklist atualizado com a linha da porta.
