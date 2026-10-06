# Agente filtra por etiqueta do contato — Plano de implementação

> **Para agentes que forem executar:** SKILL OBRIGATÓRIA: use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans para implementar tarefa por tarefa. Os passos usam checkbox (`- [ ]`).

**Objetivo:** quando um contato manda mensagem, cada agente só responde se o contato passar no filtro de etiquetas daquele agente ("responder só quem tem uma destas" / "nunca responder quem tem uma destas"). Com vários agentes no mesmo número, cada contato cai no agente da etiqueta dele. Se nenhum agente aceitar o contato, a IA fica calada e a conversa fica no Inbox.

**Arquitetura:** o filtro mora na versão do agente, em `ai_agent_versions.trigger_config.filters.contact_tags_include` / `contact_tags_exclude` (jsonb, então **sem migration**), e passa pelo fluxo de rascunho → publicação como o horário de funcionamento. Uma regra pura (`lib/agent-engine/agent/filtro-de-etiquetas.ts`) decide se um agente aceita as etiquetas do contato. O resolvedor do turno (`resolve-turn-agent.ts`) passa a carregar **todos** os agentes publicados no número e escolhe o primeiro, na ordem de preferência, que aceita o contato. Todo agente que a régua carregaria (campanha, membro do roteador, reserva, agente do número) passa pelo filtro. Quando a régua termina sem agente **porque alguém foi recusado**, o desfecho novo `fora_das_etiquetas` faz o turno sair calado, em vez de cair no agente genérico. A tela ganha a seção "Filtro por etiqueta do contato" no bloco "Quando ele entra em ação", com sugestões das etiquetas em uso.

**Stack:** Next.js 16 App Router, React 19, TypeScript estrito, Zod 4, `pg` (motor do agente), Supabase, Vitest + Testing Library.

## Decisões já tomadas com o usuário

- **É filtro, não gatilho.** Pôr ou tirar etiqueta não faz agente nenhum escrever. O filtro só é consultado quando o contato manda mensagem (e quando um follow-up do agente vai sair).
- **As duas listas**: "Responder só quem tem uma destas etiquetas" e "Nunca responder quem tem uma destas etiquetas". A segunda vence.
- **Por agente**, não por número: agentes diferentes no mesmo número, cada um atendendo a sua etiqueta.
- **Nenhum agente aceita ⇒ silêncio** (nunca o agente genérico). Para ter um agente que pegue "todo o resto", o dono publica um sem filtro com ordem de preferência mais baixa.
- A campanha também respeita o filtro do agente dela.

## Restrições globais

- Repositório: `repo/` (o git de verdade). Branch nova `feat/agente-filtra-por-etiqueta` a partir de `escale/main`. Nunca `reset --hard` nem force.
- **Nenhuma branch, commit, push ou PR sem OK explícito do usuário.** Os passos "Commit" abaixo só rodam depois do OK.
- Gerenciador: **pnpm** (nunca npm/yarn).
- **Sem migration e sem escrita no banco de produção.** O filtro vive no jsonb `trigger_config` que já existe.
- Etiquetas comparadas: **as do contato** (`contacts.tags`, as do Inbox). As do negócio (`crm_leads.tags`) ficam de fora.
- Comparação sempre pela forma normalizada de `lib/contacts/tag-normalizada.ts` (`normalizarTag`/`normalizarTags`: apara, minúscula, corta em 40).
- Todo texto que aparece na tela passa por `t()` de `@/hooks/i18n/useT`, e toda chave nova ganha linha em espanhol em `lib/i18n/dicionario.ts`. Quem cobra é `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`.
- **Todo campo de `PublishedAgentConfig` precisa de um leitor literal `agentConfig.<campo>`** fora de `agent-config.ts` — quem cobra é `tests/unit/knobs-da-versao-publicada-sao-aplicados.test.ts`. Por isso o parâmetro do filtro no resolvedor se chama `agentConfig`.
- **O schema não pode completar chave que a tela não mandou** (sem `.default([])` nas listas novas): o botão Publicar compara o formulário com a versão salva (`lib/ai/agents/mesmo-rascunho.ts`), e uma chave inventada pelo servidor o deixa cinza para sempre. Pelo mesmo motivo a tela grava a lista vazia como `undefined`, e já normalizada.
- Arquivos de `lib/agent-engine/` usam aspas simples; `lib/ai`, `lib/contacts`, `app/` usam aspas duplas. Comentários em português explicando o PORQUÊ. Sem `console.log`. Imports com `@/`.
- `pnpm test:unit` roda **sem caminho** no fim. Não corte a saída com `| tail`.
- Destino (DoD 18): **núcleo**.

## Fora do escopo (registrado para não virar surpresa)

- Worker legado de `rag_bot` (`workers/ai-response-worker.ts`): agente legado não tem esta tela.
- O dreno (`lib/agent-engine/edge/crm/drain.ts`) não muda: ele segue enfileirando, e o turno sai **antes de qualquer chamada de modelo**. Exceção conhecida: com **roteador por intenção ativo** no número, o classificador roda antes do filtro (uma chamada barata por mensagem de contato que ninguém vai atender).
- A aba **Teste** do agente ignora o filtro (testa o agente direto, sem a régua de escolha).
- O limiar de sentimento (`lib/ai/agents/agente-da-conversa.ts`) com dois agentes no número continua usando o de maior preferência.
- A opção "Só responder quando a mensagem falar de algo específico" (`keyword_regex`) não é lida pelo motor de hoje. Fica para uma tarefa separada.

## Arquivos

| Arquivo | Ação | O que muda |
|---|---|---|
| `lib/agent-engine/agent/filtro-de-etiquetas.ts` | Criar | Tipo `FiltroDeEtiquetas`, `lerFiltroDeEtiquetas`, `agenteAtendeAsEtiquetas`, `TETO_DE_ETIQUETAS_NO_FILTRO` |
| `lib/agent-engine/agent/filtro-de-etiquetas.test.ts` | Criar | Testes da regra pura |
| `lib/ai/agents/validation.ts` | Modificar | `filters.contact_tags_include/_exclude` no schema, normalizados, sem default |
| `tests/unit/filtro-de-etiquetas-no-schema.test.ts` | Criar | O schema preserva e não inventa as listas |
| `lib/agent-engine/agent/agent-config.ts` | Modificar | `loadPublishedAgentConfigsDaSessao` (lista); `loadPublishedAgentConfig` vira "o primeiro da lista"; campo `filtroDeEtiquetas` |
| `lib/agent-engine/agent/agent-config.test.ts` | Modificar | Testes da lista e do campo |
| `lib/agent-engine/agent/resolve-turn-agent.ts` | Modificar | Filtro em todo agente carregado; desfecho `fora_das_etiquetas`; lê `contacts.tags` pela conversa |
| `lib/agent-engine/agent/resolve-turn-agent.test.ts` | Modificar | Dublê da lista + casos do filtro |
| `tests/unit/autonomia-routing-selection.test.ts`, `tests/unit/assistido-respeita-o-gate.test.ts`, `tests/unit/assistido-roda-as-deteccoes.test.ts` | Modificar | Mock do módulo ganha `loadPublishedAgentConfigsDaSessao` |
| `lib/agent-engine/agent/inbound-turn.ts` | Modificar | Turno sai calado em `fora_das_etiquetas` (dois pontos) |
| `tests/unit/agente-filtra-por-etiqueta-no-turno.test.ts` | Criar | O turno real respeita o filtro |
| `lib/contacts/etiquetas-em-uso.ts` | Criar | `lerEtiquetasDeContatoEmUso` (a leitura que hoje mora na rota) |
| `app/api/v1/contact-tags/route.ts` | Modificar | Passa a usar a leitura compartilhada |
| `app/app/ai/agents/[id]/_components/EtiquetasDoFiltroInput.tsx` | Criar | Campo de etiquetas com sugestões e aviso de etiqueta inexistente |
| `app/app/ai/agents/[id]/_components/TriggerEditor.tsx` | Modificar | Seção "Filtro por etiqueta do contato" |
| `app/app/ai/agents/[id]/_components/AgentForm.tsx`, `AgentTabs.tsx`, `app/app/ai/agents/[id]/page.tsx`, `app/app/ai/agents/new/page.tsx` | Modificar | Prop `etiquetasDeContato` com as sugestões, lidas no servidor |
| `lib/i18n/dicionario.ts` | Modificar | Espanhol das chaves novas |
| `tests/unit/filtro-de-etiqueta-na-tela-do-agente.test.tsx` | Criar | A tela grava o que promete |
| `CHANGELOG.md` | Modificar | Entrada em `[Não lançado]` |

---

### Task 0: Branch (só depois do OK do usuário)

- [ ] **Step 1: Criar a branch a partir de `escale/main`**

```bash
cd "/c/Documentos/projetos claude/Deskcom CRM/repo"
git status --short          # esperado: só este plano como arquivo não rastreado
git fetch escale
git switch -c feat/agente-filtra-por-etiqueta escale/main
```

Esperado: `Switched to a new branch 'feat/agente-filtra-por-etiqueta'`. O plano (não rastreado) vem junto.

---

### Task 1: A regra pura do filtro

**Files:**
- Create: `lib/agent-engine/agent/filtro-de-etiquetas.ts`
- Test: `lib/agent-engine/agent/filtro-de-etiquetas.test.ts`

**Interfaces:**
- Produces:
  - `interface FiltroDeEtiquetas { incluir: string[]; excluir: string[] }`
  - `lerFiltroDeEtiquetas(triggerConfig: unknown): FiltroDeEtiquetas | null`
  - `agenteAtendeAsEtiquetas(filtro: FiltroDeEtiquetas | null | undefined, etiquetasDoContato: readonly string[]): boolean`
  - `const TETO_DE_ETIQUETAS_NO_FILTRO = 20`

- [ ] **Step 1: Escrever o teste que falha**

`lib/agent-engine/agent/filtro-de-etiquetas.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { agenteAtendeAsEtiquetas, lerFiltroDeEtiquetas } from './filtro-de-etiquetas';

describe('lerFiltroDeEtiquetas', () => {
  it('lê as duas listas e normaliza (minúscula, sem borda, sem repetida)', () => {
    expect(
      lerFiltroDeEtiquetas({
        filters: { contact_tags_include: [' Cliente ', 'cliente', 'VIP'], contact_tags_exclude: ['Fornecedor'] },
      }),
    ).toEqual({ incluir: ['cliente', 'vip'], excluir: ['fornecedor'] });
  });

  it('sem filtro declarado ⇒ null (atende todos)', () => {
    expect(lerFiltroDeEtiquetas(null)).toBeNull();
    expect(lerFiltroDeEtiquetas({})).toBeNull();
    expect(lerFiltroDeEtiquetas({ filters: { ignore_groups: true } })).toBeNull();
    expect(lerFiltroDeEtiquetas({ filters: { contact_tags_include: [], contact_tags_exclude: [] } })).toBeNull();
  });

  it('forma torta falha ABERTA: vira "sem filtro", nunca mordaça', () => {
    expect(lerFiltroDeEtiquetas({ filters: { contact_tags_include: 'cliente' } })).toBeNull();
    expect(lerFiltroDeEtiquetas({ filters: { contact_tags_include: [42, null, '  '] } })).toBeNull();
  });
});

describe('agenteAtendeAsEtiquetas', () => {
  const soCliente = { incluir: ['cliente'], excluir: [] };

  it('sem filtro, atende qualquer contato — inclusive sem etiqueta', () => {
    expect(agenteAtendeAsEtiquetas(null, [])).toBe(true);
    expect(agenteAtendeAsEtiquetas(undefined, ['x'])).toBe(true);
  });

  it('"só quem tem": atende quem tem uma delas e recusa quem não tem nenhuma', () => {
    expect(agenteAtendeAsEtiquetas(soCliente, ['cliente', 'sp'])).toBe(true);
    expect(agenteAtendeAsEtiquetas(soCliente, ['lead'])).toBe(false);
    expect(agenteAtendeAsEtiquetas(soCliente, [])).toBe(false);
  });

  it('compara sem caixa e sem espaço de borda (etiqueta antiga gravada torta)', () => {
    expect(agenteAtendeAsEtiquetas(soCliente, [' Cliente '])).toBe(true);
  });

  it('"nunca quem tem" vence "só quem tem"', () => {
    const filtro = { incluir: ['cliente'], excluir: ['inadimplente'] };
    expect(agenteAtendeAsEtiquetas(filtro, ['cliente', 'inadimplente'])).toBe(false);
  });

  it('só "nunca quem tem": atende todos menos quem tem a etiqueta', () => {
    const filtro = { incluir: [], excluir: ['fornecedor'] };
    expect(agenteAtendeAsEtiquetas(filtro, [])).toBe(true);
    expect(agenteAtendeAsEtiquetas(filtro, ['fornecedor'])).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run lib/agent-engine/agent/filtro-de-etiquetas.test.ts`
Expected: FAIL — `Failed to resolve import "./filtro-de-etiquetas"`.

- [ ] **Step 3: Implementar**

`lib/agent-engine/agent/filtro-de-etiquetas.ts`:

```ts
/**
 * FILTRO POR ETIQUETA DO CONTATO — "este agente responde a quem escreveu?"
 *
 * NÃO é gatilho. Pôr ou tirar uma etiqueta não faz agente nenhum escrever para
 * ninguém. O filtro só é consultado quando o contato MANDA mensagem (ou quando
 * um follow-up do agente vai sair): aí, entre os agentes que poderiam atender
 * a conversa, vale o primeiro cujo filtro aceita as etiquetas do contato. Se
 * nenhum aceitar, a IA fica calada e a conversa segue no Inbox
 * (`resolve-turn-agent.ts`, desfecho `fora_das_etiquetas`).
 *
 * Mora na versão do agente (`ai_agent_versions.trigger_config.filters`), ao
 * lado do horário de funcionamento: muda no rascunho e vale quando publica.
 *
 *   contact_tags_include — responde só quem tem ALGUMA destas. Vazio = todos.
 *   contact_tags_exclude — nunca responde quem tem alguma destas. Vence o include.
 *
 * As etiquetas comparadas são as do CONTATO (`contacts.tags`), as do Inbox. As
 * do negócio (`crm_leads.tags`) ficam de fora.
 *
 * Leitura defensiva que falha ABERTA, como `janela-de-atendimento.ts`: jsonb com
 * forma estranha vira "sem filtro". Quem garante a forma é o schema de gravação
 * (`lib/ai/agents/validation.ts`); um filtro torto que calasse o agente para
 * todo mundo seria pior que um filtro ignorado.
 */
import { normalizarTag, normalizarTags } from '@/lib/contacts/tag-normalizada';

/** Teto de etiquetas por lista — o mesmo na tela e no schema. */
export const TETO_DE_ETIQUETAS_NO_FILTRO = 20;

export interface FiltroDeEtiquetas {
  /** Responde só quem tem alguma destas. Vazio = qualquer contato. */
  incluir: string[];
  /** Nunca responde quem tem alguma destas. Vence `incluir`. */
  excluir: string[];
}

function listaDeEtiquetas(bruto: unknown): string[] {
  if (!Array.isArray(bruto)) return [];
  return normalizarTags(bruto.filter((t): t is string => typeof t === 'string'));
}

/** Extrai o filtro de `trigger_config`. `null` = sem filtro (as duas listas vazias ou ausentes). */
export function lerFiltroDeEtiquetas(triggerConfig: unknown): FiltroDeEtiquetas | null {
  if (typeof triggerConfig !== 'object' || triggerConfig === null) return null;
  const filters = (triggerConfig as { filters?: unknown }).filters;
  if (typeof filters !== 'object' || filters === null) return null;
  const { contact_tags_include, contact_tags_exclude } = filters as {
    contact_tags_include?: unknown;
    contact_tags_exclude?: unknown;
  };
  const incluir = listaDeEtiquetas(contact_tags_include);
  const excluir = listaDeEtiquetas(contact_tags_exclude);
  if (incluir.length === 0 && excluir.length === 0) return null;
  return { incluir, excluir };
}

/** A regra: `excluir` vence; `incluir` vazio aceita todos; senão, basta uma em comum. */
export function agenteAtendeAsEtiquetas(
  filtro: FiltroDeEtiquetas | null | undefined,
  etiquetasDoContato: readonly string[],
): boolean {
  if (filtro === null || filtro === undefined) return true;
  const doContato = new Set(etiquetasDoContato.map(normalizarTag));
  if (filtro.excluir.some((t) => doContato.has(t))) return false;
  if (filtro.incluir.length === 0) return true;
  return filtro.incluir.some((t) => doContato.has(t));
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run lib/agent-engine/agent/filtro-de-etiquetas.test.ts`
Expected: PASS (8 testes).

- [ ] **Step 5: Commit (só com OK)**

```bash
git add lib/agent-engine/agent/filtro-de-etiquetas.ts lib/agent-engine/agent/filtro-de-etiquetas.test.ts
git commit -m "feat(agente): regra pura do filtro por etiqueta do contato"
```

---

### Task 2: O schema da versão aceita o filtro

**Files:**
- Modify: `lib/ai/agents/validation.ts` (imports no topo; `triggerConfigSchema`, por volta da linha 26)
- Test: `tests/unit/filtro-de-etiquetas-no-schema.test.ts`

**Interfaces:**
- Consumes: `TETO_DE_ETIQUETAS_NO_FILTRO`, `lerFiltroDeEtiquetas` (Task 1); `normalizarTags` de `@/lib/contacts/tag-normalizada`.
- Produces: `trigger_config.filters.contact_tags_include?: string[]` e `contact_tags_exclude?: string[]` aceitos por `versionCreateSchema` e `versionPatchSchema`, gravados normalizados.

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/filtro-de-etiquetas-no-schema.test.ts`:

```ts
/**
 * O SCHEMA DA VERSÃO GUARDA O FILTRO POR ETIQUETA — e não inventa nada.
 *
 * É o schema da rota PATCH /versions/[vid], por onde a tela salva. Sem o campo
 * declarado o Zod o descartaria em silêncio e o filtro nunca ligaria pela tela
 * (o mesmo defeito que o aviso de fora do horário teve). E sem `default`: uma
 * chave completada pelo servidor trava o botão Publicar (`mesmo-rascunho.ts`).
 */
import { describe, expect, it } from "vitest";

import { lerFiltroDeEtiquetas } from "@/lib/agent-engine/agent/filtro-de-etiquetas";
import { versionPatchSchema } from "@/lib/ai/agents/validation";

describe("o schema da versão guarda o filtro por etiqueta", () => {
  it("preserva as duas listas e grava normalizado", () => {
    const parsed = versionPatchSchema.safeParse({
      trigger_config: {
        filters: { contact_tags_include: [" Cliente ", "cliente"], contact_tags_exclude: ["VIP"] },
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.trigger_config?.filters).toMatchObject({
      contact_tags_include: ["cliente"],
      contact_tags_exclude: ["vip"],
    });
    expect(lerFiltroDeEtiquetas(parsed.data?.trigger_config)).toEqual({ incluir: ["cliente"], excluir: ["vip"] });
  });

  it("não inventa as chaves quando a tela não mandou (senão o Publicar trava)", () => {
    const parsed = versionPatchSchema.safeParse({ trigger_config: { filters: { ignore_groups: true } } });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.trigger_config?.filters).not.toHaveProperty("contact_tags_include");
    expect(parsed.data?.trigger_config?.filters).not.toHaveProperty("contact_tags_exclude");
  });

  it("recusa mais de 20 etiquetas numa lista", () => {
    const muitas = Array.from({ length: 21 }, (_, i) => `t${i}`);
    const parsed = versionPatchSchema.safeParse({ trigger_config: { filters: { contact_tags_include: muitas } } });
    expect(parsed.success).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/filtro-de-etiquetas-no-schema.test.ts`
Expected: FAIL no primeiro caso (`contact_tags_include` some do resultado, porque o Zod descarta chave não declarada) e no terceiro (`success` é `true`).

- [ ] **Step 3: Implementar**

Em `lib/ai/agents/validation.ts`, junto dos outros imports do topo:

```ts
import { TETO_DE_ETIQUETAS_NO_FILTRO } from "@/lib/agent-engine/agent/filtro-de-etiquetas";
import { normalizarTags } from "@/lib/contacts/tag-normalizada";
```

Logo **antes** de `const triggerConfigSchema = z`:

```ts
/**
 * Uma lista do filtro por etiqueta do agente (`filtro-de-etiquetas.ts`). Grava
 * já normalizada — a mesma forma de `contacts.tags` — e SEM default: chave
 * ausente tem de continuar ausente, senão o servidor completa um `[]` que a
 * tela não mandou e o botão Publicar fica cinza para sempre (`mesmo-rascunho.ts`).
 */
const etiquetasDoFiltroSchema = z
  .array(z.string().max(200))
  .max(TETO_DE_ETIQUETAS_NO_FILTRO)
  .transform((lista) => normalizarTags(lista));
```

Dentro de `filters: z.object({ ... })`, logo depois do bloco `business_hours: z.object({...}).nullable().optional().default(null),`:

```ts
        // Filtro, não gatilho: decide só se ESTE agente responde a quem escreveu.
        contact_tags_include: etiquetasDoFiltroSchema.optional(),
        contact_tags_exclude: etiquetasDoFiltroSchema.optional(),
```

Não mexa no `.default({ ignore_groups: true, ... })` de `filters`.

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/filtro-de-etiquetas-no-schema.test.ts tests/unit/aviso-fora-do-horario.test.ts`
Expected: PASS nos dois arquivos.

- [ ] **Step 5: Commit (só com OK)**

```bash
git add lib/ai/agents/validation.ts tests/unit/filtro-de-etiquetas-no-schema.test.ts
git commit -m "feat(agente): versão do agente guarda o filtro por etiqueta"
```

---

### Task 3: Carregar todos os agentes publicados no número

**Files:**
- Modify: `lib/agent-engine/agent/agent-config.ts:244-267` (`loadPublishedAgentConfig`)
- Test: `lib/agent-engine/agent/agent-config.test.ts`

**Interfaces:**
- Produces: `loadPublishedAgentConfigsDaSessao(db: pg.Pool, organizationId: string, channelSessionId: string): Promise<PublishedAgentConfig[]>` — ordem `priority desc, created_at asc`.
- `loadPublishedAgentConfig` mantém a assinatura e o comportamento (o primeiro da lista ou `null`): `draft-reply.ts`, `prospecting/store.ts` e `loadConversationAgentConfig` não mudam.

- [ ] **Step 1: Escrever o teste que falha**

No fim de `lib/agent-engine/agent/agent-config.test.ts` (e acrescente `loadPublishedAgentConfigsDaSessao` ao import da linha 4):

```ts
describe('loadPublishedAgentConfigsDaSessao — todos os agentes do número', () => {
  function poolComLinhas(linhas: Record<string, unknown>[]): pg.Pool {
    return { query: vi.fn().mockResolvedValue({ rows: linhas }) } as unknown as pg.Pool;
  }

  it('devolve todos, na ordem do banco, filtrando organização e número', async () => {
    const pool = poolComLinhas([
      { ...baseRow, agent_id: 'a1', version_id: 'v1' },
      { ...baseRow, agent_id: 'a2', version_id: 'v2' },
    ]);
    const lista = await loadPublishedAgentConfigsDaSessao(pool, 'org-1', 'sess-1');
    expect(lista.map((c) => c.agentId)).toEqual(['a1', 'a2']);
    const [sql, values] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(values).toEqual(['org-1', 'sess-1']);
    expect(sql).toContain('order by a.priority desc, a.created_at asc');
    expect(sql).not.toContain('limit 1');
  });

  it('número sem agente publicado ⇒ lista vazia', async () => {
    expect(await loadPublishedAgentConfigsDaSessao(poolComLinhas([]), 'org-1', 'sess-1')).toEqual([]);
  });

  it('loadPublishedAgentConfig segue devolvendo só o primeiro', async () => {
    const pool = poolComLinhas([
      { ...baseRow, agent_id: 'a1', version_id: 'v1' },
      { ...baseRow, agent_id: 'a2', version_id: 'v2' },
    ]);
    expect((await loadPublishedAgentConfig(pool, 'org-1', 'sess-1'))?.agentId).toBe('a1');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run lib/agent-engine/agent/agent-config.test.ts`
Expected: FAIL — `loadPublishedAgentConfigsDaSessao is not a function`.

- [ ] **Step 3: Implementar**

Em `lib/agent-engine/agent/agent-config.ts`, substitua a função `loadPublishedAgentConfig` inteira (linhas 244-267) por:

```ts
/**
 * TODOS os agentes publicados no número, em ordem de preferência
 * (`priority desc, created_at asc`). O turno escolhe o primeiro que aceita as
 * etiquetas do contato (`resolve-turn-agent.ts`, filtro por etiqueta); sem
 * etiquetas na conta, o primeiro — o mesmo de `loadPublishedAgentConfig`.
 */
export async function loadPublishedAgentConfigsDaSessao(
  db: pg.Pool,
  organizationId: string,
  channelSessionId: string,
): Promise<PublishedAgentConfig[]> {
  const { rows } = await db.query<Row>(
    `select ${SELECT_AGENT_CONFIG_COLUMNS}
     from ai_agents a
     join ai_agent_versions v on v.id = a.published_version_id
     where a.organization_id = $1
       and a.archived_at is null
       -- is_active é semântica do rag_bot legado; para mcp_agent "ativo" =
       -- published_version_id preenchido + não arquivado. Pausar NÃO despublica
       -- (grava só paused_at): o pausado vem aqui, e o turno sai no pausedAt.
       and v.status = 'published'
       and v.channel_session_id = $2
     order by a.priority desc, a.created_at asc`,
    [organizationId, channelSessionId],
  );
  return rows.map(mapAgentConfigRow);
}

/** O agente de maior preferência do número, sem olhar etiquetas. `null` = nenhum publicado. */
export async function loadPublishedAgentConfig(
  db: pg.Pool,
  organizationId: string,
  channelSessionId: string,
): Promise<PublishedAgentConfig | null> {
  return (await loadPublishedAgentConfigsDaSessao(db, organizationId, channelSessionId))[0] ?? null;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run lib/agent-engine/agent/agent-config.test.ts lib/agent-engine/agent/draft-reply.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (só com OK)**

```bash
git add lib/agent-engine/agent/agent-config.ts lib/agent-engine/agent/agent-config.test.ts
git commit -m "refactor(agente): carregar todos os agentes publicados no número"
```

---

### Task 4: O resolvedor do turno aplica o filtro

**Files:**
- Modify: `lib/agent-engine/agent/agent-config.ts` (interface `PublishedAgentConfig` e `mapAgentConfigRow`)
- Modify: `lib/agent-engine/agent/resolve-turn-agent.ts`
- Modify: `lib/agent-engine/agent/resolve-turn-agent.test.ts`
- Modify: `tests/unit/autonomia-routing-selection.test.ts`, `tests/unit/assistido-respeita-o-gate.test.ts`, `tests/unit/assistido-roda-as-deteccoes.test.ts`

**Interfaces:**
- Consumes: `lerFiltroDeEtiquetas`, `agenteAtendeAsEtiquetas`, `FiltroDeEtiquetas` (Task 1); `loadPublishedAgentConfigsDaSessao` (Task 3).
- Produces:
  - `PublishedAgentConfig.filtroDeEtiquetas?: FiltroDeEtiquetas | null`
  - `TurnAgentResolution['outcome']` ganha `'fora_das_etiquetas'`
  - `export interface ResolveTurnAgentInput` (o tipo que era inline) com o campo novo `etiquetasDoContato?: readonly string[] | null`
  - `ResolveTurnAgentDeps.loadAgentesDaSessao?: typeof loadPublishedAgentConfigsDaSessao` **no lugar de** `loadPublishedAgentConfig`
  - `resolveConversationTurn` lê `contacts.tags` na mesma consulta da conversa e repassa como `etiquetasDoContato`.

- [ ] **Step 1: Preparar os dublês dos testes que já existem**

O resolvedor passa a pedir a LISTA do número. Os dublês de hoje devolvem UM agente; adapte sem reescrever os casos.

Em `lib/agent-engine/agent/resolve-turn-agent.test.ts`, logo depois de `idAwareLoader()`:

```ts
/** O dublê de sempre devolvia UM agente da sessão; o motor agora pede a lista do número. */
function umaListaDe(umAgente: ReturnType<typeof vi.fn>) {
  return vi.fn(async (...args: unknown[]) => {
    const config = await umAgente(...args);
    return config ? [config] : [];
  });
}

/** Agente com filtro por etiqueta — o resto da config é o `fakeConfig`. */
function comFiltro(agentId: string, incluir: string[], excluir: string[] = []): PublishedAgentConfig {
  return { ...fakeConfig(agentId), filtroDeEtiquetas: { incluir, excluir } };
}
```

Em `makeDeps`, no tipo de `overrides` acrescente:

```ts
  loadAgentesDaSessao?: ReturnType<typeof vi.fn>;
  agenteDaCampanha?: ReturnType<typeof vi.fn>;
```

e no objeto devolvido troque a linha `loadPublishedAgentConfig: overrides.loadPublishedAgentConfig ?? vi.fn(),` por:

```ts
    loadAgentesDaSessao: overrides.loadAgentesDaSessao ?? umaListaDe(overrides.loadPublishedAgentConfig ?? vi.fn()),
    agenteDaCampanha: overrides.agenteDaCampanha,
```

No caso `'16. router sem fallback E sessão sem agente publicado → config null (genérico) com aviso'`, troque:

```ts
    const loadPublishedAgentConfig = vi.fn().mockResolvedValue(null);
```
por
```ts
    const loadAgentesDaSessao = vi.fn().mockResolvedValue([]);
```
e, na chamada, `loadPublishedAgentConfig } as never);` por `loadAgentesDaSessao } as never);`.

Nos três testes de `tests/unit/` que mockam o módulo inteiro, acrescente ao objeto devolvido por `vi.mock('@/lib/agent-engine/agent/agent-config', ...)` (nos dois que usam `importOriginal`, depois da linha `loadConversationAgentConfig: mocks.conversationAgent,`):

```ts
  // O turno pede a LISTA do número (filtro por etiqueta); o dublê de sempre devolve um agente só.
  loadPublishedAgentConfigsDaSessao: async (...a: unknown[]) => {
    const c = await mocks.bySession(...a);
    return c ? [c] : [];
  },
```

- [ ] **Step 2: Escrever os testes que falham**

No fim de `lib/agent-engine/agent/resolve-turn-agent.test.ts`:

```ts
describe('resolveTurnAgent — filtro por etiqueta do contato (regra 8)', () => {
  const semRouter = () => vi.fn().mockResolvedValue(null);
  const entrada = (etiquetasDoContato?: string[]) => ({
    ...baseInput, signal: 'oi', stickyAgentId: null, stickyIntent: null,
    ...(etiquetasDoContato !== undefined ? { etiquetasDoContato } : {}),
  });

  it('dois agentes no número: atende o primeiro que aceita as etiquetas do contato', async () => {
    const loadAgentesDaSessao = vi.fn().mockResolvedValue([
      comFiltro('agent-clientes', ['cliente']),
      comFiltro('agent-leads', ['lead']),
    ]);
    const out = await resolveTurnAgent({} as never, {} as never, entrada(['lead']),
      makeDeps({ loadActiveRouter: semRouter(), loadAgentesDaSessao }));
    expect(out.outcome).toBe('no_router');
    expect(out.config?.agentId).toBe('agent-leads');
  });

  it('nenhum agente aceita ⇒ fora_das_etiquetas, sem config (nunca o genérico)', async () => {
    const loadAgentesDaSessao = vi.fn().mockResolvedValue([comFiltro('agent-clientes', ['cliente'])]);
    const out = await resolveTurnAgent({} as never, {} as never, entrada([]),
      makeDeps({ loadActiveRouter: semRouter(), loadAgentesDaSessao }));
    expect(out.config).toBeNull();
    expect(out.outcome).toBe('fora_das_etiquetas');
  });

  it('número sem agente nenhum segue no genérico (no_router), como antes — ninguém foi recusado', async () => {
    const loadAgentesDaSessao = vi.fn().mockResolvedValue([]);
    const out = await resolveTurnAgent({} as never, {} as never, entrada([]),
      makeDeps({ loadActiveRouter: semRouter(), loadAgentesDaSessao }));
    expect(out.config).toBeNull();
    expect(out.outcome).toBe('no_router');
  });

  it('"nunca responder quem tem" vence "só quem tem"', async () => {
    const loadAgentesDaSessao = vi.fn().mockResolvedValue([comFiltro('agent-clientes', ['cliente'], ['inadimplente'])]);
    const out = await resolveTurnAgent({} as never, {} as never, entrada(['cliente', 'inadimplente']),
      makeDeps({ loadActiveRouter: semRouter(), loadAgentesDaSessao }));
    expect(out.outcome).toBe('fora_das_etiquetas');
  });

  it('sem etiquetas informadas (quem chama não sabe) não filtra: vale o primeiro, como antes', async () => {
    const loadAgentesDaSessao = vi.fn().mockResolvedValue([comFiltro('agent-clientes', ['cliente'])]);
    const out = await resolveTurnAgent({} as never, {} as never, entrada(),
      makeDeps({ loadActiveRouter: semRouter(), loadAgentesDaSessao }));
    expect(out.config?.agentId).toBe('agent-clientes');
    expect(out.outcome).toBe('no_router');
  });

  it('roteador casa um membro que recusa o contato ⇒ atende o agente do número que aceita', async () => {
    const r = router({ sticky: false, fallbackAgentId: null });
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.9 });
    const loadPublishedAgentConfigById = vi.fn(async (_db: unknown, _org: unknown, id: string) => comFiltro(id, ['cliente']));
    const loadAgentesDaSessao = vi.fn().mockResolvedValue([fakeConfig('agent-geral')]);
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...entrada(['lead']), signal: 'quero comprar' },
      makeDeps({ loadActiveRouter: vi.fn().mockResolvedValue(r), classifyIntent, loadPublishedAgentConfigById, loadAgentesDaSessao }));
    expect(out.config?.agentId).toBe('agent-geral');
    expect(out.outcome).toBe('no_match');
  });

  it('roteador: reserva que recusa vale como "sem reserva"; ninguém aceita ⇒ fora_das_etiquetas', async () => {
    const r = router({ sticky: false, fallbackAgentId: 'agent-fallback' });
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: null, confidence: 0.1 });
    const loadPublishedAgentConfigById = vi.fn(async (_db: unknown, _org: unknown, id: string) => comFiltro(id, ['cliente']));
    const loadAgentesDaSessao = vi.fn().mockResolvedValue([]);
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...entrada(['lead']), signal: 'blablabla' },
      makeDeps({ loadActiveRouter: vi.fn().mockResolvedValue(r), classifyIntent, loadPublishedAgentConfigById, loadAgentesDaSessao }));
    expect(out.config).toBeNull();
    expect(out.outcome).toBe('fora_das_etiquetas');
    expect(out.routerId).toBe('router-1');
  });

  it('campanha: o agente da campanha que recusa o contato não atende; segue a régua do número', async () => {
    const agenteDaCampanha = vi.fn().mockResolvedValue('agent-campanha');
    const loadPublishedAgentConfigById = vi.fn(async (_db: unknown, _org: unknown, id: string) => comFiltro(id, ['cliente']));
    const loadAgentesDaSessao = vi.fn().mockResolvedValue([fakeConfig('agent-geral')]);
    const out = await resolveTurnAgent({} as never, {} as never, entrada(['lead']),
      makeDeps({ loadActiveRouter: semRouter(), agenteDaCampanha, loadPublishedAgentConfigById, loadAgentesDaSessao }));
    expect(out.config?.agentId).toBe('agent-geral');
    expect(out.outcome).toBe('no_router');
  });
});

describe('resolveConversationTurn — etiquetas do contato', () => {
  it('lê as etiquetas pela conversa (nunca do payload) e as aplica', async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('from conversations')) {
          return { rows: [{ active_ai_agent_id: null, active_intent: null, contact_tags: ['Lead'] }] };
        }
        return { rows: [] };
      }),
    };
    const loadAgentesDaSessao = vi.fn().mockResolvedValue([
      comFiltro('agent-clientes', ['cliente']),
      comFiltro('agent-leads', ['lead']),
    ]);
    const out = await resolveConversationTurn(db as never, {} as never, { ...baseInput, inbound: false },
      makeDeps({ loadActiveRouter: vi.fn().mockResolvedValue(null), loadAgentesDaSessao }));
    expect(out.config?.agentId).toBe('agent-leads');
    const [sql, values] = db.query.mock.calls.find(([q]) => q.includes('from conversations'))!;
    expect(sql).toContain('left join contacts');
    expect(values).toEqual(['org-1', 'conv-1']);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm vitest run lib/agent-engine/agent/resolve-turn-agent.test.ts`
Expected: FAIL — todos os casos antigos que passam pelo agente do número (o motor ainda chama `deps.loadPublishedAgentConfig`, que `makeDeps` não entrega mais) e os casos novos (`fora_das_etiquetas` não existe).

- [ ] **Step 4: Campo `filtroDeEtiquetas` na config publicada**

Em `lib/agent-engine/agent/agent-config.ts`:

Import, junto dos outros:
```ts
import { lerFiltroDeEtiquetas, type FiltroDeEtiquetas } from './filtro-de-etiquetas';
```

Na interface `PublishedAgentConfig`, logo depois de `avisoForaDoHorario?: string | null;`:
```ts
  /**
   * Filtro por etiqueta do contato (`trigger_config.filters.contact_tags_*`).
   * NÃO é gatilho: decide só se ESTE agente responde a quem escreveu. `null` =
   * sem filtro (atende todos). Opcional porque nasce depois das fixtures que
   * montam esta interface à mão. Quem obedece é `resolve-turn-agent.ts`.
   */
  filtroDeEtiquetas?: FiltroDeEtiquetas | null;
```

Em `mapAgentConfigRow`, logo depois de `avisoForaDoHorario: lerTextoDoAvisoForaDoHorario(r.trigger_config),`:
```ts
    filtroDeEtiquetas: lerFiltroDeEtiquetas(r.trigger_config),
```

- [ ] **Step 5: O resolvedor**

Em `lib/agent-engine/agent/resolve-turn-agent.ts`:

**5a.** No comentário do topo, logo antes da linha ` */` que fecha o bloco (depois do parágrafo "⚠️ \"silêncio não é desfecho possível\""), acrescente:

```ts
 *
 * Regra 8 — FILTRO POR ETIQUETA (`filtro-de-etiquetas.ts`). Todo agente que a
 * régua acima carregaria (campanha, membro, reserva, agente do número) passa
 * antes pelo filtro de etiquetas da versão dele; o que recusa o contato é
 * pulado como se não existisse. Se a régua termina sem agente E alguém foi
 * recusado, o desfecho é `fora_das_etiquetas`: silêncio, de propósito, nunca o
 * genérico — o dono disse quem este número atende. Sem agente nenhum (ninguém
 * foi recusado) vale a regra 5, como antes: genérico.
```

**5b.** Imports — troque:
```ts
import {
  loadPublishedAgentConfig,
  loadPublishedAgentConfigById,
  type PublishedAgentConfig,
} from './agent-config';
```
por:
```ts
import {
  loadPublishedAgentConfigById,
  loadPublishedAgentConfigsDaSessao,
  type PublishedAgentConfig,
} from './agent-config';
import { agenteAtendeAsEtiquetas } from './filtro-de-etiquetas';
```

**5c.** No tipo do desfecho, troque:
```ts
    /** A conversa nasceu de uma campanha que declarou agente (migration 0267). */
    | 'campanha';
```
por:
```ts
    /** A conversa nasceu de uma campanha que declarou agente (migration 0267). */
    | 'campanha'
    /**
     * Havia agente para a conversa, mas nenhum aceita as etiquetas do contato
     * (`filtro-de-etiquetas.ts`). `config` é null e o turno NÃO cai no
     * genérico: a IA fica calada e a conversa segue no Inbox.
     */
    | 'fora_das_etiquetas';
```

**5d.** Em `ResolveTurnAgentDeps`, troque:
```ts
  loadPublishedAgentConfig?: typeof loadPublishedAgentConfig;
```
por:
```ts
  /** Os agentes publicados no número, em ordem de preferência. */
  loadAgentesDaSessao?: typeof loadPublishedAgentConfigsDaSessao;
```

**5e.** Troque o cabeçalho da função e as primeiras linhas do corpo. O trecho atual é:

```ts
export async function resolveTurnAgent(
  db: pg.Pool,
  llmCfg: LlmEdgeConfig,
  input: {
    tenantId: string;
    leadId: string;
    jobId: string;
    channelSessionId: string;
    conversationId: string;
    signal: string | null;
    /** Texto que o cliente digitou na última inbound ('' para mídia) — o Jev, R4. */
    signalBody?: string | null;
    /** A mensagem de onde o `signal` saiu — amarra a observação do Jev a ela. */
    signalMessageId?: string | null;
    stickyAgentId: string | null;
    stickyIntent: string | null;
    /** Mensagens anteriores ao signal, mais antiga → mais recente. Default []. */
    recentMessages?: ClassifierContextMessage[];
  },
  deps: ResolveTurnAgentDeps,
): Promise<TurnAgentResolution> {
  const inicioDoRoteamento = Date.now();
  const _loadActiveRouter = deps.loadActiveRouter ?? loadActiveRouter;
  const _loadAgentById = deps.loadPublishedAgentConfigById ?? loadPublishedAgentConfigById;
  const _loadAgentBySession = deps.loadPublishedAgentConfig ?? loadPublishedAgentConfig;
  const _classifyIntent = deps.classifyIntent ?? classifyIntent;
  const _consultarJev = deps.consultarJev ?? consultarJevNoRoteador;
```

Substitua por:

```ts
export interface ResolveTurnAgentInput {
  tenantId: string;
  leadId: string;
  jobId: string;
  channelSessionId: string;
  conversationId: string;
  signal: string | null;
  /** Texto que o cliente digitou na última inbound ('' para mídia) — o Jev, R4. */
  signalBody?: string | null;
  /** A mensagem de onde o `signal` saiu — amarra a observação do Jev a ela. */
  signalMessageId?: string | null;
  stickyAgentId: string | null;
  stickyIntent: string | null;
  /** Mensagens anteriores ao signal, mais antiga → mais recente. Default []. */
  recentMessages?: ClassifierContextMessage[];
  /**
   * `contacts.tags` do contato da conversa (regra 8). Ausente/null = não filtra:
   * quem chama sem saber as etiquetas mantém a régua de antes. `[]` = contato
   * sem etiqueta, que um filtro "só quem tem" recusa.
   */
  etiquetasDoContato?: readonly string[] | null;
}

/** As recusas por etiqueta de UM turno: separa "ninguém aceitou" de "não havia agente". */
interface FiltroDoTurno {
  aceita(agentConfig: PublishedAgentConfig): boolean;
  readonly recusou: boolean;
}

function criarFiltroDoTurno(etiquetas: readonly string[] | null): FiltroDoTurno {
  let recusou = false;
  return {
    aceita(agentConfig) {
      if (etiquetas === null || agenteAtendeAsEtiquetas(agentConfig.filtroDeEtiquetas, etiquetas)) return true;
      recusou = true;
      return false;
    },
    get recusou() {
      return recusou;
    },
  };
}

export async function resolveTurnAgent(
  db: pg.Pool,
  llmCfg: LlmEdgeConfig,
  input: ResolveTurnAgentInput,
  deps: ResolveTurnAgentDeps,
): Promise<TurnAgentResolution> {
  const filtro = criarFiltroDoTurno(input.etiquetasDoContato ?? null);
  const resultado = await escolherAgenteDoTurno(db, llmCfg, input, deps, filtro);
  if (resultado.config !== null || !filtro.recusou) return resultado;
  // Regra 8: a régua terminou sem agente PORQUE alguém recusou o contato.
  deps.log.info('resolve-turn-agent: nenhum agente desta conversa aceita as etiquetas do contato — a IA fica calada', {
    conversationId: input.conversationId,
    routerId: resultado.routerId,
    outcomeDaRegua: resultado.outcome,
  });
  return {
    config: null,
    routerId: resultado.routerId,
    intentName: null,
    confidence: resultado.confidence,
    outcome: 'fora_das_etiquetas',
  };
}

async function escolherAgenteDoTurno(
  db: pg.Pool,
  llmCfg: LlmEdgeConfig,
  input: ResolveTurnAgentInput,
  deps: ResolveTurnAgentDeps,
  filtro: FiltroDoTurno,
): Promise<TurnAgentResolution> {
  const inicioDoRoteamento = Date.now();
  const _loadActiveRouter = deps.loadActiveRouter ?? loadActiveRouter;
  const _loadAgentById = deps.loadPublishedAgentConfigById ?? loadPublishedAgentConfigById;
  const _loadAgentesDaSessao = deps.loadAgentesDaSessao ?? loadPublishedAgentConfigsDaSessao;
  const _classifyIntent = deps.classifyIntent ?? classifyIntent;
  const _consultarJev = deps.consultarJev ?? consultarJevNoRoteador;
  // O agente publicado DO NÚMERO: o primeiro, na ordem de preferência, que
  // aceita as etiquetas do contato. Sem etiquetas na conta, o primeiro — o
  // mesmo que `loadPublishedAgentConfig` devolve.
  const agenteDaSessao = async (): Promise<PublishedAgentConfig | null> =>
    (await _loadAgentesDaSessao(db, input.tenantId, input.channelSessionId)).find((c) => filtro.aceita(c)) ?? null;
```

O resto do corpo continua igual, com as trocas 5f a 5j.

**5f.** Degrau 0 (campanha) — troque:
```ts
    if (idDaCampanha !== null) {
      const config = await _loadAgentById(db, input.tenantId, idDaCampanha);
      if (config !== null) {
        return { config, routerId: null, intentName: null, confidence: null, outcome: 'campanha' };
      }
      deps.log.warn('agente da campanha sem versão publicada; seguindo pela régua do número', {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
      });
    }
```
por:
```ts
    if (idDaCampanha !== null) {
      const config = await _loadAgentById(db, input.tenantId, idDaCampanha);
      if (config !== null && filtro.aceita(config)) {
        return { config, routerId: null, intentName: null, confidence: null, outcome: 'campanha' };
      }
      // Sem versão publicada OU com um filtro por etiqueta que recusa este
      // contato: a campanha não manda mais que o filtro do agente dela.
      deps.log.warn(
        config === null
          ? 'agente da campanha sem versão publicada; seguindo pela régua do número'
          : 'agente da campanha não aceita as etiquetas do contato; seguindo pela régua do número',
        { tenantId: input.tenantId, conversationId: input.conversationId },
      );
    }
```

**5g.** Sem roteador — troque:
```ts
      return {
        config: await _loadAgentBySession(db, input.tenantId, input.channelSessionId),
        routerId: null,
        intentName: null,
        confidence: null,
        outcome: 'no_router',
      };
```
por:
```ts
      return {
        config: await agenteDaSessao(),
        routerId: null,
        intentName: null,
        confidence: null,
        outcome: 'no_router',
      };
```

**5h.** Troque a função `resolveFallback` inteira (do comentário `// fallback do router ou genérico — usado pelas regras 4, 5, 6 e 7.` até o `};` que a fecha) por:

```ts
    // fallback do router ou genérico — usado pelas regras 4, 5, 6 e 7.
    const resolveFallback = async (
      outcome: 'no_match' | 'classifier_failed',
      confidence: number | null,
    ): Promise<TurnAgentResolution> => {
      const doFallback =
        router.fallbackAgentId === null ? null : await _loadAgentById(db, input.tenantId, router.fallbackAgentId);
      // Regra 8: uma reserva que recusa as etiquetas deste contato vale como
      // "sem reserva" — quem atende é o agente do número que aceitar o contato.
      if (router.fallbackAgentId === null || (doFallback !== null && !filtro.aceita(doFallback))) {
        // Regra 5: sem fallback declarado, quem atende é o agente publicado da
        // SESSÃO — o comportamento de antes do router existir. `null` aqui
        // (nenhum publicado) segue caindo no genérico, como sempre.
        const daSessao = await agenteDaSessao();
        if (daSessao === null && !filtro.recusou) {
          deps.log.warn('resolve-turn-agent: router sem fallback e sessão sem agente publicado — turno cai no genérico', {
            routerId: router.id,
            outcome,
          });
        }
        return { config: daSessao, routerId: router.id, intentName: null, confidence, outcome };
      }
      const config = doFallback;
      if (config === null) {
        // regra 7: fallback também sem versão publicada — fim legítimo da
        // linha, mas o outcome que já explicava a causa (classifier_failed)
        // não vira 'no_match' por engano; só rebaixa quando o motivo era
        // genuinamente "sem match", pra não mentir sobre o que aconteceu.
        deps.log.warn('resolve-turn-agent: fallbackAgentId sem versão publicada — turno cai no genérico', {
          routerId: router.id,
          fallbackAgentId: router.fallbackAgentId,
        });
      }
      return {
        config,
        routerId: router.id,
        intentName: null,
        confidence,
        outcome: outcome === 'classifier_failed' ? 'classifier_failed' : config === null ? 'no_match' : 'fallback',
      };
    };
```

**5i.** Em `loadMatchedOrFallback`, logo depois do bloco `if (config === null) { ... return resolveFallback('no_match', confidence); }`, acrescente:

```ts
      if (!filtro.aceita(config)) {
        // Regra 8: o membro casado não atende as etiquetas deste contato.
        deps.log.info('resolve-turn-agent: agente casado não aceita as etiquetas do contato — tentando fallback do router', {
          routerId: router.id,
          matchedOutcome: outcome,
          agentId,
        });
        return resolveFallback('no_match', confidence);
      }
```

**5j.** No `catch` do fim da função, troque:
```ts
      config: await _loadAgentBySession(db, input.tenantId, input.channelSessionId),
```
por:
```ts
      config: await agenteDaSessao(),
```

Confira que não sobrou nenhum `_loadAgentBySession`:

Run: `grep -n "_loadAgentBySession\|loadPublishedAgentConfig\b" lib/agent-engine/agent/resolve-turn-agent.ts`
Expected: só linhas de comentário (nenhuma chamada).

**5k.** Em `resolveConversationTurn`, troque a primeira consulta:

```ts
  const { rows } = await db.query<{
    active_ai_agent_id: string | null;
    active_intent: string | null;
  }>(
    'select active_ai_agent_id,active_intent from conversations where organization_id=$1 and id=$2',
    [input.tenantId, input.conversationId],
  );
```
por:
```ts
  // As etiquetas do contato vêm na MESMA leitura da conversa: o contato é o
  // da própria conversa (fonte confiável), nunca o do payload — e o turno não
  // ganha uma consulta a mais por causa do filtro (regra 8).
  const { rows } = await db.query<{
    active_ai_agent_id: string | null;
    active_intent: string | null;
    contact_tags: string[] | null;
  }>(
    `select cv.active_ai_agent_id, cv.active_intent, ct.tags as contact_tags
       from conversations cv
       left join contacts ct on ct.id = cv.contact_id and ct.organization_id = cv.organization_id
      where cv.organization_id=$1 and cv.id=$2`,
    [input.tenantId, input.conversationId],
  );
  // Linha sem a coluna (conversa sem contato, dublê de teste) vale como "sem etiqueta".
  const tagsDoContato = rows[0]?.contact_tags;
  const etiquetasDoContato = Array.isArray(tagsDoContato) ? tagsDoContato : [];
```

e, na chamada final `return resolveTurnAgent(db, llmCfg, { ...input, signal, ... }, deps);`, acrescente `etiquetasDoContato,` ao objeto (ao lado de `recentMessages,`).

- [ ] **Step 6: Rodar e ver passar**

Run: `pnpm vitest run lib/agent-engine/agent/resolve-turn-agent.test.ts tests/unit/autonomia-routing-selection.test.ts tests/unit/assistido-respeita-o-gate.test.ts tests/unit/assistido-roda-as-deteccoes.test.ts tests/unit/knobs-da-versao-publicada-sao-aplicados.test.ts lib/agent-engine/agent/agent-config.test.ts`
Expected: PASS em todos. Se `knobs-da-versao-publicada-sao-aplicados` acusar `filtroDeEtiquetas` órfão, confira que o parâmetro em `criarFiltroDoTurno` se chama exatamente `agentConfig` (o gate procura `agentConfig.filtroDeEtiquetas`).

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: sem erros.

- [ ] **Step 8: Commit (só com OK)**

```bash
git add lib/agent-engine/agent/agent-config.ts lib/agent-engine/agent/resolve-turn-agent.ts lib/agent-engine/agent/resolve-turn-agent.test.ts tests/unit/autonomia-routing-selection.test.ts tests/unit/assistido-respeita-o-gate.test.ts tests/unit/assistido-roda-as-deteccoes.test.ts
git commit -m "feat(agente): escolha do agente respeita o filtro por etiqueta do contato"
```

---

### Task 5: O turno sai calado quando ninguém aceita o contato

**Files:**
- Modify: `lib/agent-engine/agent/inbound-turn.ts` (dois pontos: `runAgentTurn`, linha ~2049; handler do inbound, linha ~5033)
- Test: `tests/unit/agente-filtra-por-etiqueta-no-turno.test.ts`

**Interfaces:**
- Consumes: desfecho `'fora_das_etiquetas'` de `TurnAgentResolution` (Task 4); `loadPublishedAgentConfigsDaSessao` (Task 3); `PublishedAgentConfig.filtroDeEtiquetas` (Task 4).

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/agente-filtra-por-etiqueta-no-turno.test.ts` (o arnês é o de `tests/unit/autonomia-routing-selection.test.ts`):

```ts
/**
 * FILTRO POR ETIQUETA, NO TURNO DE VERDADE.
 *
 * Não é gatilho: o contato escreve, e o agente só responde se passar no filtro
 * de etiquetas da versão publicada dele. Quando nenhum agente do número aceita,
 * o turno termina calado — antes de qualquer chamada de modelo, sem rascunho e
 * sem cair no agente genérico (que é o que `config: null` faria sem a regra 8).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedAgentConfig } from '@/lib/agent-engine/agent/agent-config';

const mocks = vi.hoisted(() => ({
  router: vi.fn(), classify: vi.fn(), byId: vi.fn(), agentesDaSessao: vi.fn(), conversationAgent: vi.fn(),
  draft: vi.fn(), operation: vi.fn(),
  handoff: vi.fn(async () => false), elegibilidade: vi.fn(async (): Promise<unknown> => null),
  jev: vi.fn(() => ({ estado: Promise.resolve('desligada'), escolha: Promise.resolve(null), observar: vi.fn() })),
}));
vi.mock('@/lib/ai/decisao/roteador', () => ({ consultarJevNoRoteador: mocks.jev }));
vi.mock('@/lib/agent-engine/agent/router-config', () => ({ loadActiveRouter: mocks.router }));
vi.mock('@/lib/agent-engine/agent/intent-classifier', () => ({ classifyIntent: mocks.classify }));
vi.mock('@/lib/agent-engine/agent/agent-config', () => ({
  loadPublishedAgentConfigById: mocks.byId,
  loadPublishedAgentConfigsDaSessao: mocks.agentesDaSessao,
  loadPublishedAgentConfig: vi.fn(async () => null),
  loadConversationAgentConfig: mocks.conversationAgent,
}));
vi.mock('@/lib/agent-engine/agent/reply-drafts', () => ({ generateReplyDraft: mocks.draft }));
vi.mock('@/lib/atendimento/fronteira-server', () => ({
  currentExecutionBoundary: () => undefined, setExecutionAgentOperation: mocks.operation,
  guardServiceEffect: vi.fn(),
}));
vi.mock('@/lib/agent-engine/agent/human-handoff', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), isLeadInHandoff: mocks.handoff,
}));
vi.mock('@/lib/agent-engine/guardrails/camadas-da-org', () => ({
  lerCamadasDaOrg: vi.fn(async () => ({})), camadaLigada: vi.fn(() => false),
}));
vi.mock('@/lib/agent-engine/agent/fuso-da-org', () => ({ fusoDaOrganizacao: vi.fn(async () => 'UTC') }));
vi.mock('@/lib/ai/elegibilidade/consulta-pg', () => ({ decidirElegibilidadeDaConversa: mocks.elegibilidade }));
vi.mock('@/lib/agent-engine/agent/turno-ja-respondido', () => ({
  ultimaInboundJaRespondida: vi.fn(async () => false),
  anotarUltimaInboundVista: vi.fn(async () => {}),
}));
vi.mock('@/lib/agent-engine/pacing/store', () => ({ loadChannelKnobs: vi.fn(async () => ({ knobs: {} })) }));
vi.mock('@/lib/agent-engine/pacing/engine', () => ({ janelaDeEnvioAberta: () => true, proximaAberturaDaJanela: vi.fn() }));
vi.mock('@/lib/agent-engine/pacing/aviso-de-janela', () => ({
  resolverAvisoDeJanela: vi.fn(async () => 0), avisarJanelaFechada: vi.fn(),
}));

import { createInboundTurnHandler, type InboundTurnDeps } from '@/lib/agent-engine/agent/inbound-turn';

const ids = {
  org: '12000000-0000-4000-8000-000000000001', contact: '12000000-0000-4000-8000-000000000002',
  conversation: '12000000-0000-4000-8000-000000000003', channel: '12000000-0000-4000-8000-000000000004',
  job: '12000000-0000-4000-8000-000000000005',
};
const job = {
  id: ids.job, organization_id: ids.org, contact_id: ids.contact, kind: 'inbound_turn',
  payload: { conversation_id: ids.conversation, contact_id: ids.contact, channel_session_id: ids.channel,
    inbound_message_id: '12000000-0000-4000-8000-000000000006', crm_event_id: '12000000-0000-4000-8000-000000000007' },
};
const deps = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  llmCfg: {}, crmCfg: {}, knobs: {},
} as unknown as InboundTurnDeps;

function agente(id: string, incluir: string[], excluir: string[] = []): PublishedAgentConfig {
  return { agentId: id, versionId: `version-${id}`, operationRevision: '7', operationMode: 'automatic',
    pausedAt: null, filtroDeEtiquetas: { incluir, excluir } } as PublishedAgentConfig;
}

/** Banco falso: toda leitura devolve a conversa, com as etiquetas do contato. */
function banco(etiquetas: string[]) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('id<>$3')) return { rows: [] };
      return { rows: [{ active_ai_agent_id: null, active_intent: null, body: 'Oi, tudo bem?', contact_tags: etiquetas }] };
    }),
  };
}

const chegou = new Error('operação do agente escolhido alcançada');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handoff.mockResolvedValue(false);
  mocks.elegibilidade.mockResolvedValue(null);
  mocks.router.mockResolvedValue(null);
  // Para no limite operacional: depois da escolha, antes de qualquer efeito externo.
  mocks.operation.mockImplementation(() => { throw chegou; });
});

describe('o agente só responde quem passa no filtro de etiquetas', () => {
  it('contato sem a etiqueta: turno termina calado, sem rascunho e sem operação', async () => {
    mocks.agentesDaSessao.mockResolvedValue([agente('A', ['cliente'])]);
    await createInboundTurnHandler(deps)(job as never, banco([]) as never, { workerId: 'worker' });
    expect(mocks.operation).not.toHaveBeenCalled();
    expect(mocks.draft).not.toHaveBeenCalled();
    expect(deps.log.info).toHaveBeenCalledWith(
      'turno pulado — nenhum agente aceita as etiquetas do contato', expect.anything());
  });

  // Controle: sem ele, um `return` cedo demais deixaria o caso acima verde por ausência.
  it('contato com a etiqueta: o turno segue com o agente', async () => {
    mocks.agentesDaSessao.mockResolvedValue([agente('A', ['cliente'])]);
    await expect(createInboundTurnHandler(deps)(job as never, banco(['cliente']) as never, { workerId: 'worker' }))
      .rejects.toBe(chegou);
    expect(mocks.operation).toHaveBeenCalledExactlyOnceWith({
      organizationId: ids.org, agentId: 'A', versionId: 'version-A', revision: '7',
    });
  });

  it('dois agentes no número: cada contato cai no agente da etiqueta dele', async () => {
    mocks.agentesDaSessao.mockResolvedValue([agente('A', ['cliente']), agente('B', ['lead'])]);
    await expect(createInboundTurnHandler(deps)(job as never, banco(['lead']) as never, { workerId: 'worker' }))
      .rejects.toBe(chegou);
    expect(mocks.operation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agentId: 'B' }));
  });

  it('"nunca responder quem tem" vence: contato com as duas etiquetas fica sem resposta', async () => {
    mocks.agentesDaSessao.mockResolvedValue([agente('A', ['cliente'], ['inadimplente'])]);
    await createInboundTurnHandler(deps)(job as never, banco(['cliente', 'inadimplente']) as never, { workerId: 'worker' });
    expect(mocks.operation).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/agente-filtra-por-etiqueta-no-turno.test.ts`
Expected: FAIL no primeiro e no quarto caso — com `config: null` o turno segue para o agente genérico, e o log "turno pulado — nenhum agente aceita…" não aparece. Os casos 2 e 3 já passam (a escolha veio da Task 4).

- [ ] **Step 3: Implementar**

Em `lib/agent-engine/agent/inbound-turn.ts`:

**3a.** Handler do inbound: logo depois de `const operationAgent = resolvedAgent.config;` (linha única no arquivo):

```ts
    // Regra 8 (filtro por etiqueta): havia agente para esta conversa, mas
    // nenhum aceita as etiquetas do contato. Sai ANTES do rascunho do
    // assistido e de anotar a mensagem como vista — silêncio de propósito.
    if (resolvedAgent.outcome === 'fora_das_etiquetas') {
      deps.log.info('turno pulado — nenhum agente aceita as etiquetas do contato', {
        job_id: job.id,
        conversation_id: payload.conversation_id,
      });
      return;
    }
```

**3b.** `runAgentTurn` (serve também follow-up e caso): logo depois de `const agentConfig = routed.config;` (linha única no arquivo):

```ts
  // Regra 8 (filtro por etiqueta): `agentConfig === null` seguiria para o
  // agente GENÉRICO logo abaixo. Aqui o null quer dizer "o dono disse que este
  // contato não é atendido por ninguém deste número" — então o turno acaba.
  if (routed.outcome === 'fora_das_etiquetas') {
    runLog.info('turno pulado — nenhum agente aceita as etiquetas do contato', { kind: liveJob().kind });
    return;
  }
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/agente-filtra-por-etiqueta-no-turno.test.ts tests/unit/autonomia-routing-selection.test.ts tests/unit/assistido-respeita-o-gate.test.ts tests/unit/assistido-roda-as-deteccoes.test.ts`
Expected: PASS em todos.

- [ ] **Step 5: Commit (só com OK)**

```bash
git add lib/agent-engine/agent/inbound-turn.ts tests/unit/agente-filtra-por-etiqueta-no-turno.test.ts
git commit -m "feat(agente): turno fica calado quando nenhum agente aceita as etiquetas do contato"
```

---

### Task 6: Uma leitura só das etiquetas em uso

Refatoração sem mudança de comportamento: a consulta que a rota `GET /api/v1/contact-tags` faz passa para `lib/`, para a página do agente reaproveitar no servidor (o editor do agente não pode buscar sozinho: os testes o renderizam sem `QueryClient`).

**Files:**
- Create: `lib/contacts/etiquetas-em-uso.ts`
- Modify: `app/api/v1/contact-tags/route.ts`
- Test (já existe, tem de continuar verde): `tests/unit/tags-do-contato-rota.test.ts`

**Interfaces:**
- Produces: `lerEtiquetasDeContatoEmUso(db: SupabaseClient, organizationId: string): Promise<EtiquetasEmUso>` com `type EtiquetasEmUso = { ok: true; tags: string[] } | { ok: false; causa: string }`.

- [ ] **Step 1: Confirmar que a rota está verde antes**

Run: `pnpm vitest run tests/unit/tags-do-contato-rota.test.ts tests/unit/tags-do-contato-com-sugestao.test.tsx`
Expected: PASS.

- [ ] **Step 2: Criar a leitura compartilhada**

`lib/contacts/etiquetas-em-uso.ts`:

```ts
/**
 * As etiquetas em uso nos contatos de uma organização — as sugestões dos
 * editores de etiqueta.
 *
 * Uma leitura só para dois consumidores: a rota `GET /api/v1/contact-tags`
 * (editor do Inbox, no cliente) e as páginas do agente (no servidor, que mandam
 * a lista por prop para o filtro por etiqueta — o editor do agente é
 * renderizado sem `QueryClient` nos testes e não busca nada sozinho).
 *
 * `db` é o client da SESSÃO (a RLS de `contacts` isola) ou o admin com
 * `organizationId` de fonte confiável — o filtro por organização é explícito
 * nos dois casos.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizarTag } from "@/lib/contacts/tag-normalizada";

// ponytail: lê só os 1000 contatos com tag mais recentes (o PostgREST não faz
// `distinct unnest`); tag rara de contato antigo pode faltar na sugestão. Some
// quando a leitura do vocabulário da S4 (#852) substituir esta consulta.
export const CONTATOS_LIDOS = 1000;
export const TETO_DE_TAGS = 200;

export type EtiquetasEmUso = { ok: true; tags: string[] } | { ok: false; causa: string };

export async function lerEtiquetasDeContatoEmUso(
  db: SupabaseClient,
  organizationId: string,
): Promise<EtiquetasEmUso> {
  const { data, error } = await db
    .from("contacts")
    .select("tags")
    .eq("organization_id", organizationId)
    .neq("tags", "{}")
    .order("updated_at", { ascending: false })
    .limit(CONTATOS_LIDOS);
  if (error) return { ok: false, causa: error.message };

  // NORMALIZADA, com a mesma função que o editor usa ao gravar: o rótulo do
  // chip tem de dizer exatamente o que o clique grava. Devolvendo a tag crua,
  // "VIP", "vip " e "vip" viravam TRÊS chips que gravam a mesma coisa.
  const tags = [
    ...new Set(
      (data ?? [])
        .flatMap((c: { tags: string[] | null }) => c.tags ?? [])
        .map(normalizarTag)
        .filter(Boolean),
    ),
  ]
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .slice(0, TETO_DE_TAGS);
  return { ok: true, tags };
}
```

- [ ] **Step 3: A rota usa a leitura**

Em `app/api/v1/contact-tags/route.ts`:

1. No comentário do topo, troque `Consolidar é trocar o corpo da consulta abaixo por` por `Consolidar é trocar o corpo da consulta de \`lib/contacts/etiquetas-em-uso.ts\` por`, e `apagando \`CONTATOS_LIDOS\`, \`TETO_DE_TAGS\` e o \`ponytail:\` logo abaixo` por `apagando \`CONTATOS_LIDOS\`, \`TETO_DE_TAGS\` e o \`ponytail:\` de lá`.
2. Tudo do primeiro `import` até o fim do arquivo vira:

```ts
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { lerEtiquetasDeContatoEmUso } from "@/lib/contacts/etiquetas-em-uso";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;

  const lidas = await lerEtiquetasDeContatoEmUso(await createClient(), authz.org.orgId);
  // A falha SOBE: lista vazia diria "não há tags" em cima de um erro.
  //
  // Fechada na AÇÃO, aberta na INFORMAÇÃO: o cliente recebe uma frase do
  // produto — a mensagem crua do Postgres é para quem opera, não para o
  // navegador — e a causa vai inteira para o log, junto do `requestId` que a
  // resposta carrega.
  if (!lidas.ok) {
    logger.error("contact-tags: leitura das tags do contato falhou", {
      requestId,
      orgId: authz.org.orgId,
      cause: lidas.causa,
    });
    return fail("internal_error", "Não foi possível carregar as tags.", 500, { requestId });
  }
  return ok(lidas.tags, { requestId });
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/tags-do-contato-rota.test.ts tests/unit/tags-do-contato-com-sugestao.test.tsx`
Expected: PASS (os mesmos casos do Step 1).

- [ ] **Step 5: Commit (só com OK)**

```bash
git add lib/contacts/etiquetas-em-uso.ts app/api/v1/contact-tags/route.ts
git commit -m "refactor(contatos): leitura das etiquetas em uso sai da rota para lib"
```

---

### Task 7: A tela do agente

**Files:**
- Create: `app/app/ai/agents/[id]/_components/EtiquetasDoFiltroInput.tsx`
- Modify: `app/app/ai/agents/[id]/_components/TriggerEditor.tsx`
- Modify: `app/app/ai/agents/[id]/_components/AgentForm.tsx` (tipo `Props`, linha ~163; uso do `TriggerEditor`, linha ~1232)
- Modify: `app/app/ai/agents/[id]/_components/AgentTabs.tsx` (props, linha ~26; `<AgentForm>`, linha ~81)
- Modify: `app/app/ai/agents/[id]/page.tsx` (`Promise.all`, linha ~104; `<AgentTabs>`, linha ~222)
- Modify: `app/app/ai/agents/new/page.tsx` (`Promise.all`, linha ~39; `<AgentForm>`, linha ~62)
- Modify: `lib/i18n/dicionario.ts` (antes do `};` que fecha `DICIONARIO`, linha ~14373)
- Test: `tests/unit/filtro-de-etiqueta-na-tela-do-agente.test.tsx`

**Interfaces:**
- Consumes: `TETO_DE_ETIQUETAS_NO_FILTRO` (Task 1); `lerEtiquetasDeContatoEmUso` (Task 6); `normalizarTag`, `TAMANHO_MAXIMO_DA_TAG` de `@/lib/contacts/tag-normalizada`.
- Produces:
  - `TriggerValue.filters.contact_tags_include?: string[]` e `contact_tags_exclude?: string[]`
  - prop `TriggerEditor.sugestoesDeEtiquetas?: readonly string[]`
  - prop `AgentForm.etiquetasDeContato?: string[]` e `AgentTabs.etiquetasDeContato?: string[]`
  - `EtiquetasDoFiltroInput({ id, rotulo, ajuda, value, onChange, sugestoes?, disabled? })`, com `onChange: (next: string[] | undefined) => void`

- [ ] **Step 1: Escrever o teste que falha**

`tests/unit/filtro-de-etiqueta-na-tela-do-agente.test.tsx`:

```tsx
/**
 * O FILTRO POR ETIQUETA NA TELA DO AGENTE — grava o que promete.
 *
 * Três armadilhas que este arquivo segura:
 *   - a tela dizer que é gatilho (não é: colocar etiqueta não dispara mensagem);
 *   - gravar a etiqueta crua ("Cliente ") quando o servidor normaliza ("cliente"):
 *     o formulário nunca bateria com a versão salva e o Publicar travaria;
 *   - gravar `[]` ao tirar a última etiqueta: chave que a versão salva não tem,
 *     mesmo defeito (`lib/ai/agents/mesmo-rascunho.ts`).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import {
  TriggerEditor,
  type TriggerValue,
} from "@/app/app/ai/agents/[id]/_components/TriggerEditor";

const BASE: TriggerValue = {
  events: ["message"],
  filters: { ignore_groups: true, ignore_self: true, keyword_regex: null, business_hours: null },
  concurrency: "one_per_conversation",
};

function montar(value: TriggerValue = BASE, sugestoes?: string[]) {
  const onChange = vi.fn();
  render(<TriggerEditor value={value} onChange={onChange} sugestoesDeEtiquetas={sugestoes} />);
  return onChange;
}

function emitido(onChange: ReturnType<typeof vi.fn>): TriggerValue {
  return onChange.mock.calls.at(-1)![0] as TriggerValue;
}

describe("filtro por etiqueta do contato no editor do agente", () => {
  it("diz que é filtro, não gatilho", () => {
    montar();
    expect(screen.getByText(/Não é um gatilho/)).toBeInTheDocument();
  });

  it("digitar e Enter grava a etiqueta normalizada em contact_tags_include", () => {
    const onChange = montar();
    const campo = screen.getByLabelText("Responder só quem tem uma destas etiquetas");
    fireEvent.change(campo, { target: { value: "  Cliente " } });
    fireEvent.keyDown(campo, { key: "Enter" });
    expect(emitido(onChange).filters.contact_tags_include).toEqual(["cliente"]);
  });

  it("a lista de exclusão grava em contact_tags_exclude", () => {
    const onChange = montar();
    const campo = screen.getByLabelText("Nunca responder quem tem uma destas etiquetas");
    fireEvent.change(campo, { target: { value: "fornecedor" } });
    fireEvent.keyDown(campo, { key: "Enter" });
    expect(emitido(onChange).filters.contact_tags_exclude).toEqual(["fornecedor"]);
  });

  it("tirar a última etiqueta apaga a chave (senão o Publicar trava)", () => {
    const onChange = montar({ ...BASE, filters: { ...BASE.filters, contact_tags_include: ["cliente"] } });
    fireEvent.click(screen.getByRole("button", { name: "Remover cliente" }));
    expect(emitido(onChange).filters.contact_tags_include).toBeUndefined();
  });

  it("sugere as etiquetas em uso e um clique grava", () => {
    const onChange = montar(BASE, ["cliente", "lead"]);
    // A primeira sugestão "+ lead" é a da lista "só quem tem" (vem antes na tela).
    fireEvent.click(screen.getAllByRole("button", { name: "+ lead" })[0]!);
    expect(emitido(onChange).filters.contact_tags_include).toEqual(["lead"]);
  });

  it("avisa quando nenhum contato tem a etiqueta (erro de digitação calaria o agente)", () => {
    montar({ ...BASE, filters: { ...BASE.filters, contact_tags_include: ["clinete"] } }, ["cliente"]);
    expect(screen.getByText(/Nenhum contato tem esta etiqueta ainda/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/filtro-de-etiqueta-na-tela-do-agente.test.tsx`
Expected: FAIL — `Unable to find an element with the text: /Não é um gatilho/`.

- [ ] **Step 3: O campo de etiquetas**

`app/app/ai/agents/[id]/_components/EtiquetasDoFiltroInput.tsx`:

```tsx
"use client";
import * as React from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { TETO_DE_ETIQUETAS_NO_FILTRO } from "@/lib/agent-engine/agent/filtro-de-etiquetas";
import { normalizarTag, TAMANHO_MAXIMO_DA_TAG } from "@/lib/contacts/tag-normalizada";

/** Quantas sugestões aparecem de uma vez; digitar filtra as demais. */
const SUGESTOES_VISIVEIS = 12;

interface Props {
  id: string;
  rotulo: string;
  ajuda: string;
  value: readonly string[];
  /**
   * Lista vazia sai como `undefined`: chave ausente é o que a versão salva
   * tem, e só ela bate com o formulário na hora de liberar o Publicar
   * (`lib/ai/agents/mesmo-rascunho.ts`).
   */
  onChange: (next: string[] | undefined) => void;
  /** Etiquetas em uso nos contatos da organização. */
  sugestoes?: readonly string[];
  disabled?: boolean;
}

/** Campo de etiquetas do filtro do agente — grava já normalizado, como o servidor guarda. */
export function EtiquetasDoFiltroInput({ id, rotulo, ajuda, value, onChange, sugestoes = [], disabled }: Props) {
  const t = useT();
  const [rascunho, setRascunho] = React.useState("");
  const cheio = value.length >= TETO_DE_ETIQUETAS_NO_FILTRO;

  function adicionar(cru: string) {
    const tag = normalizarTag(cru);
    if (tag === "" || value.includes(tag) || cheio) return;
    onChange([...value, tag]);
    setRascunho("");
  }

  function remover(tag: string) {
    const resto = value.filter((x) => x !== tag);
    onChange(resto.length > 0 ? resto : undefined);
  }

  const busca = normalizarTag(rascunho);
  const oferecidas = sugestoes
    .filter((s) => !value.includes(s) && (busca === "" || s.includes(busca)))
    .slice(0, SUGESTOES_VISIVEIS);
  // Etiqueta que nenhum contato tem: quase sempre erro de digitação — e, num
  // "só quem tem", um erro desses cala o agente para todo mundo.
  const desconhecidas = sugestoes.length > 0 ? value.filter((v) => !sugestoes.includes(v)) : [];

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{rotulo}</Label>
      <div className="flex flex-wrap gap-1 rounded-md border border-border/60 p-2">
        {value.map((tag) => (
          <button
            key={tag}
            type="button"
            onClick={() => !disabled && remover(tag)}
            className="group flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs hover:bg-destructive/15"
            disabled={disabled}
            aria-label={`${t("Remover")} ${tag}`}
          >
            {tag}
            <span className="text-muted-foreground group-hover:text-destructive">×</span>
          </button>
        ))}
        {value.length === 0 ? <span className="text-xs text-muted-foreground">{t("Nenhuma etiqueta.")}</span> : null}
      </div>
      <div className="flex gap-2">
        <Input
          id={id}
          value={rascunho}
          onChange={(e) => setRascunho(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              adicionar(rascunho);
            }
          }}
          placeholder={t("Digite uma etiqueta e aperte Enter")}
          disabled={disabled || cheio}
          maxLength={TAMANHO_MAXIMO_DA_TAG}
        />
        <button
          type="button"
          className="rounded-md border border-border/60 px-3 text-xs hover:bg-muted"
          onClick={() => adicionar(rascunho)}
          disabled={disabled || rascunho.trim() === ""}
        >
          {t("Adicionar")}
        </button>
      </div>
      {oferecidas.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {oferecidas.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => adicionar(s)}
              disabled={disabled || cheio}
              className="rounded-md border border-dashed border-border/60 px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
            >
              + {s}
            </button>
          ))}
        </div>
      ) : null}
      {desconhecidas.length > 0 ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {t("Nenhum contato tem esta etiqueta ainda:")} {desconhecidas.join(", ")}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{ajuda}</p>
    </div>
  );
}
```

- [ ] **Step 4: A seção no `TriggerEditor`**

Em `app/app/ai/agents/[id]/_components/TriggerEditor.tsx`:

Import, depois dos imports de `@/components/ui/*`:
```tsx
import { EtiquetasDoFiltroInput } from "./EtiquetasDoFiltroInput";
```

Em `TriggerValue.filters`, depois de `business_hours: BusinessHoursValue | null;`:
```ts
    /** Filtro por etiqueta do contato (`lib/agent-engine/agent/filtro-de-etiquetas.ts`). Ausente = sem filtro. */
    contact_tags_include?: string[];
    contact_tags_exclude?: string[];
```

Em `interface Props`, depois de `organizationTimezone?: string;`:
```ts
  /** Etiquetas em uso nos contatos — sugestões do filtro por etiqueta. */
  sugestoesDeEtiquetas?: readonly string[];
```

Na assinatura do componente, troque `export function TriggerEditor({ value, onChange, disabled, organizationTimezone }: Props) {` por:
```tsx
export function TriggerEditor({ value, onChange, disabled, organizationTimezone, sugestoesDeEtiquetas }: Props) {
```

No fim do JSX, troque:
```tsx
        ) : null}
      </div>
    </div>
  );
}
```
por:
```tsx
        ) : null}
      </div>

      {/* Filtro, não gatilho: decide só se ESTE agente responde a quem escreveu.
          Quem obedece é o resolvedor do turno (regra 8 de resolve-turn-agent.ts). */}
      <div className="space-y-3 rounded-md border border-border/60 p-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">{t("Filtro por etiqueta do contato")}</p>
          <p className="text-xs text-muted-foreground">
            {t(
              "Não é um gatilho: colocar a etiqueta não faz o agente mandar mensagem. Quando o contato escrever, este agente só responde se ele passar por este filtro.",
            )}
          </p>
        </div>
        <EtiquetasDoFiltroInput
          id="contact_tags_include"
          rotulo={t("Responder só quem tem uma destas etiquetas")}
          ajuda={t(
            "Vazio = responde qualquer contato. Com etiquetas, quem não tiver nenhuma delas não recebe resposta deste agente.",
          )}
          value={value.filters.contact_tags_include ?? []}
          onChange={(next) => patchFilters({ contact_tags_include: next })}
          sugestoes={sugestoesDeEtiquetas}
          disabled={disabled}
        />
        <EtiquetasDoFiltroInput
          id="contact_tags_exclude"
          rotulo={t("Nunca responder quem tem uma destas etiquetas")}
          ajuda={t("Vale mesmo que o contato também tenha uma etiqueta da lista de cima.")}
          value={value.filters.contact_tags_exclude ?? []}
          onChange={(next) => patchFilters({ contact_tags_exclude: next })}
          sugestoes={sugestoesDeEtiquetas}
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">
          {t(
            "Se nenhum agente deste número aceitar o contato, a IA não responde e a conversa fica no Inbox para a equipe.",
          )}
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Espanhol das chaves novas**

Em `lib/i18n/dicionario.ts`, antes do `};` que fecha `DICIONARIO` (logo depois de `"Não foi possível guardar esta opção.": { ... },`):

```ts
  "Filtro por etiqueta do contato": { es: "Filtro por etiqueta del contacto" },
  "Não é um gatilho: colocar a etiqueta não faz o agente mandar mensagem. Quando o contato escrever, este agente só responde se ele passar por este filtro.": {
    es: "No es un disparador: poner la etiqueta no hace que el agente envíe mensajes. Cuando el contacto escriba, este agente solo responde si pasa este filtro.",
  },
  "Responder só quem tem uma destas etiquetas": { es: "Responder solo a quien tenga una de estas etiquetas" },
  "Vazio = responde qualquer contato. Com etiquetas, quem não tiver nenhuma delas não recebe resposta deste agente.": {
    es: "Vacío = responde a cualquier contacto. Con etiquetas, quien no tenga ninguna de ellas no recibe respuesta de este agente.",
  },
  "Nunca responder quem tem uma destas etiquetas": { es: "Nunca responder a quien tenga una de estas etiquetas" },
  "Vale mesmo que o contato também tenha uma etiqueta da lista de cima.": {
    es: "Aplica aunque el contacto también tenga una etiqueta de la lista de arriba.",
  },
  "Se nenhum agente deste número aceitar o contato, a IA não responde e a conversa fica no Inbox para a equipe.": {
    es: "Si ningún agente de este número acepta al contacto, la IA no responde y la conversación queda en el Inbox para el equipo.",
  },
  "Nenhuma etiqueta.": { es: "Ninguna etiqueta." },
  "Digite uma etiqueta e aperte Enter": { es: "Escribe una etiqueta y presiona Enter" },
  "Nenhum contato tem esta etiqueta ainda:": { es: "Ningún contacto tiene esta etiqueta todavía:" },
```

(`"Remover"` e `"Adicionar"` já existem no dicionário.)

- [ ] **Step 6: Rodar o teste da tela e o do espanhol**

Run: `pnpm vitest run tests/unit/filtro-de-etiqueta-na-tela-do-agente.test.tsx tests/unit/gatilho-do-agente-usa-o-fuso-da-organizacao.test.tsx tests/unit/i18n-espanhol-cobre-a-tela.test.ts`
Expected: PASS nos três.

- [ ] **Step 7: As sugestões chegam do servidor**

`app/app/ai/agents/[id]/_components/AgentForm.tsx` — no tipo `Props`, depois de `materiais?: MaterialDoAcervo[];`:
```ts
  /**
   * Etiquetas em uso nos contatos, para o filtro por etiqueta sugerir o que
   * existe. Vem por PROP, lida no servidor: o editor é renderizado sem
   * `QueryClient` nos testes e não busca nada sozinho.
   */
  etiquetasDeContato?: string[];
```
e no uso do `<TriggerEditor ... />` (dentro do card "Quando ele entra em ação"), acrescente a prop:
```tsx
              sugestoesDeEtiquetas={props.etiquetasDeContato}
```

`app/app/ai/agents/[id]/_components/AgentTabs.tsx` — nas props, depois de `materiais?: MaterialDoAcervo[];`:
```ts
  /** Etiquetas em uso nos contatos — ver `AgentForm`. */
  etiquetasDeContato?: string[];
```
e no `<AgentForm ...>`, depois de `materiais={props.materiais}`:
```tsx
          etiquetasDeContato={props.etiquetasDeContato}
```

`app/app/ai/agents/[id]/page.tsx`:
- import: `import { lerEtiquetasDeContatoEmUso } from "@/lib/contacts/etiquetas-em-uso";`
- troque `const [versionsRes, credentialsRes, channelSessions, routerMemberRes, funisRes, acervoRes] =` por `const [versionsRes, credentialsRes, channelSessions, routerMemberRes, funisRes, acervoRes, etiquetasEmUso] =`
- dentro do `Promise.all([...])`, depois da consulta de `ai_knowledge_sources` (antes do `]);`):
```ts
      // As etiquetas em uso, para o filtro por etiqueta sugerir o que existe: um
      // nome digitado errado num "só quem tem" calaria o agente. Falha aqui só
      // tira as sugestões — a pessoa ainda digita a etiqueta.
      lerEtiquetasDeContatoEmUso(supabase, activeOrg.orgId),
```
- no `<AgentTabs ...>`, depois de `materiais={materiais}`:
```tsx
        etiquetasDeContato={etiquetasEmUso.ok ? etiquetasEmUso.tags : []}
```

`app/app/ai/agents/new/page.tsx`:
- import: `import { lerEtiquetasDeContatoEmUso } from "@/lib/contacts/etiquetas-em-uso";`
- troque `const [orgRes, credentialsRes, channelSessions] = await Promise.all([` por `const [orgRes, credentialsRes, channelSessions, etiquetasEmUso] = await Promise.all([`
- dentro do `Promise.all`, depois de `listSelectableChannels(supabase, activeOrg.orgId),`:
```ts
    lerEtiquetasDeContatoEmUso(supabase, activeOrg.orgId),
```
- no `<AgentForm ...>`, depois de `channelSessions={channelSessions}`:
```tsx
        etiquetasDeContato={etiquetasEmUso.ok ? etiquetasEmUso.tags : []}
```

- [ ] **Step 8: Rodar os testes do editor e o typecheck**

Run: `pnpm vitest run tests/unit/filtro-de-etiqueta-na-tela-do-agente.test.tsx tests/unit/agent-form-abre-a-versao-certa.test.tsx tests/unit/agent-form-callback-default.test.tsx tests/unit/agent-form-prompt-nao-trunca.test.tsx tests/unit/agente-salva-sem-numero-conectado.test.tsx tests/unit/editor-de-agente-salva-o-cadastro.test.tsx tests/unit/motivo-do-publicar-fica-na-tela.test.tsx && pnpm typecheck`
Expected: PASS e typecheck sem erros.

- [ ] **Step 9: Commit (só com OK)**

```bash
git add "app/app/ai/agents/[id]/_components/EtiquetasDoFiltroInput.tsx" "app/app/ai/agents/[id]/_components/TriggerEditor.tsx" "app/app/ai/agents/[id]/_components/AgentForm.tsx" "app/app/ai/agents/[id]/_components/AgentTabs.tsx" "app/app/ai/agents/[id]/page.tsx" app/app/ai/agents/new/page.tsx lib/i18n/dicionario.ts tests/unit/filtro-de-etiqueta-na-tela-do-agente.test.tsx
git commit -m "feat(agente): tela do agente ganha o filtro por etiqueta do contato"
```

---

### Task 8: CHANGELOG e verificação final

**Files:**
- Modify: `CHANGELOG.md` (seção `## [Não lançado]`, linha ~9)

- [ ] **Step 1: Entrada no CHANGELOG**

Logo abaixo de `## [Não lançado]`:

```markdown
### Adicionado

- **O agente pode escolher quem ele atende pela etiqueta do contato** Na tela do agente, no bloco "Quando ele entra em ação", a seção **Filtro por etiqueta do contato** tem duas listas: "Responder só quem tem uma destas etiquetas" e "Nunca responder quem tem uma destas etiquetas" (a segunda vence). É filtro, não gatilho: colocar a etiqueta não faz o agente mandar mensagem; quando o contato escreve, o agente só responde se ele passar no filtro.

  Com vários agentes publicados no mesmo número, cada mensagem vai para o agente de maior "Ordem de preferência" cujo filtro aceita o contato — um agente para `cliente`, outro para `lead`, no mesmo WhatsApp. Se nenhum agente do número aceitar o contato, a IA não responde e a conversa fica no Inbox para a equipe (antes, sem agente, o número caía no agente genérico; isso continua valendo só quando não há agente nenhum). O filtro vale também para o agente de campanha, para o roteador por intenção e para os follow-ups. As etiquetas comparadas são as do contato (as do Inbox), não as do negócio. O filtro vale quando a versão é publicada. Sem migration e sem ação do operador.
```

- [ ] **Step 2: Verificação completa**

Run: `pnpm gov:verify`
Expected: typecheck, lint, `lint:channels`, `lint:role-rank` e `test:unit` verdes. Não corte a saída.

- [ ] **Step 3: Invariantes de banco (se o Docker estiver de pé)**

`gov:verify` não cobre `test:db`. A Task 3 tirou o `limit 1` da consulta do agente do número, e a Task 4 mudou a primeira consulta de `resolveConversationTurn`; as duas são medidas contra Postgres real em `tests/invariants/`.

Run: `pnpm test:db tests/invariants/agent-config-cases.test.ts tests/invariants/engine-dono-da-resposta.test.ts tests/invariants/case-reply-turn.test.ts`
Expected: PASS. Sem Docker, **não** marque como verde: registre no PR que esta suíte não rodou.

- [ ] **Step 4: Conferência manual (com o usuário, num ambiente de teste — nunca no banco de produção)**

1. Publicar o agente A com "Responder só quem tem" = `cliente`, e o agente B no mesmo número com "Responder só quem tem" = `lead`.
2. Contato com etiqueta `cliente` manda "oi" → responde o A.
3. Contato com etiqueta `lead` manda "oi" → responde o B.
4. Contato sem etiqueta manda "oi" → nenhuma resposta; a conversa aparece no Inbox; o log do worker mostra `turno pulado — nenhum agente aceita as etiquetas do contato`.
5. Pôr a etiqueta `cliente` no contato do item 4 **não** dispara mensagem nenhuma (não é gatilho). Na próxima mensagem dele, o A responde.
6. Na tela do agente, digitar `Cliente ` e salvar o rascunho → o botão Publicar acende (a etiqueta foi gravada como `cliente`).

- [ ] **Step 5: Commit (só com OK)**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): filtro por etiqueta do contato no agente"
```
