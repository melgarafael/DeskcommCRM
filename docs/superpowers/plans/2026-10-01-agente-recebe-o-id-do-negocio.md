# O agente recebe o ID do negócio — Plano de implementação

> **Para agentes que forem executar:** SKILL OBRIGATÓRIA: use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans para implementar tarefa por tarefa. Os passos usam checkbox (`- [ ]`).

**Objetivo:** o agente (Conversador e Operador) passa a RECEBER o ID do negócio (card do funil) do contato e a mandá-lo certo nas ferramentas do CRM, gravando os dados coletados nos campos do negócio.

**Arquitetura:** uma função nova (`negocioDoContato`) descobre o negócio aberto do contato com a MESMA regra que o CRM já usa (`resolveActiveLeadForContact`). O contexto do Conversador ganha o bloco `negocio` e a abertura do turno ensina a usar `negocio.id` como `lead_id`. O briefing do Operador, que hoje não tem ID nenhum (por isso ele manda `00000000-…`), ganha os IDs de contato, conversa e negócio.

**Stack:** TypeScript, Next.js, pg (motor do agente), Vitest.

## Por que (medido em produção, 2026-10-01)

- O contexto entrega `lead_id` = ID do **contato** (`lib/agent-engine/edge/crm/get-lead-context.ts:278`, issue #509). O ID do negócio não vem.
- O modelo usa esse valor em `crm_update_lead`. Ex.: mandou `9c9eb3c8…` (contato), o negócio era `aa12c790…`. O portão (`lib/leads/escopo-de-funil.ts:374`) não acha negócio e recusa com `escopo_de_funil:indisponivel`.
- Resultado: nenhuma chamada de `crm_update_lead` feita pelo agente gravou (todas recusadas com `escopo_de_funil:indisponivel`). Os campos do negócio ficam vazios.
- O Operador recebe um briefing **sem ID nenhum** (`lib/agent-engine/agent/operator-turn.ts:113`) e chama ferramentas com `00000000-0000-0000-0000-000000000000`.

## Restrições globais

- Branch nova a partir de `origin/main` atualizada (`git fetch origin` antes). Nunca `reset --hard` nem force.
- **Nenhum commit ou push sem OK explícito do usuário.** Ao fim de cada tarefa: mostrar o diff e pedir OK.
- **Não renomear** o `lead_id` do `LeadContext` (issue #509; ele circula por follow-up, case-reply, escalação e invariantes congelados). O campo novo é **somado**.
- **Não editar** nada em `tests/invariants/**` (congelado pelo hook de governança). Campo novo no `LeadContext` é **opcional** por isso.
- Toda consulta nova filtra `organization_id` (multi-tenancy).
- A escolha do negócio usa `resolveActiveLeadForContact` **sem** `defaultPipelineId`, igual ao portão de escopo em `lib/ai/runtime/tools.ts:138`. Os dois precisam concordar.
- Projeção (`lib/agent-engine/agent/projecao.ts`) é allowlist: `negocio` **não** entra no contexto projetado e não pode vazar.
- Arquivos kebab-case, imports com `@/`, comentários em português explicando o PORQUÊ, sem `console.log`.
- Destino (DoD 18): **núcleo**.

## Arquivos

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `lib/agent-engine/edge/crm/negocio-do-contato.ts` | Criar | Descobrir o negócio aberto do contato (consulta + regra existente) |
| `lib/agent-engine/edge/crm/get-lead-context.ts` | Alterar | Somar `negocio` ao `LeadContext` |
| `lib/agent-engine/agent/inbound-turn.ts` | Alterar | Abertura do turno: instrução "use `negocio.id` como `lead_id`" |
| `lib/agent-engine/agent/operator-turn.ts` | Alterar | Briefing do Operador com os IDs |
| `tests/unit/negocio-do-contato.test.ts` | Criar | Regra de escolha e tenancy |
| `tests/unit/contexto-do-agente-traz-o-negocio.test.ts` | Criar | Contexto traz `negocio`; projeção não vaza |
| `tests/unit/abertura-ensina-o-id-do-negocio.test.ts` | Criar | Instrução aparece só quando deve |
| `tests/unit/operador-recebe-os-ids.test.ts` | Criar | Briefing com IDs + guarda do call site |
| `.changes/agente-grava-no-negocio-certo.md` | Criar | Fragmento de release (DoD 17) |

---

### Tarefa 1: Descobrir o negócio aberto do contato

**Arquivos:**
- Criar: `lib/agent-engine/edge/crm/negocio-do-contato.ts`
- Teste: `tests/unit/negocio-do-contato.test.ts`

**Interfaces:**
- Consome: `resolveActiveLeadForContact`, `LeadCandidate` de `@/lib/leads/active-lead`; `Queryable` de `lib/agent-engine/queue/queue.ts`.
- Produz:
  - `export type NegocioNoContexto = { id: string; funil: string; etapa: string | null } | { id: null; aviso: string }`
  - `export async function negocioDoContato(db: Queryable, tenantId: string, contactId: string): Promise<NegocioNoContexto | null>`

- [ ] **Passo 0: Criar a branch**

```bash
cd repo
git status --short            # tem de estar vazio
git fetch origin
git checkout -b fix/agente-recebe-o-id-do-negocio origin/main
```

- [ ] **Passo 1: Escrever o teste que falha**

`tests/unit/negocio-do-contato.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { negocioDoContato } from "@/lib/agent-engine/edge/crm/negocio-do-contato";

/**
 * O agente mandava o id do CONTATO onde o CRM pede o do NEGÓCIO (issue #509) e
 * nenhum campo do card era gravado. Esta função entrega o id certo — e a escolha
 * tem de ser a MESMA do roteamento de atividade e do portão de escopo.
 */
type Linha = {
  id: string;
  organization_id: string;
  pipeline_id: string;
  last_activity_at: Date | null;
  created_at: Date;
  funil: string;
  etapa: string | null;
};

function dbFalso(linhas: Linha[]) {
  const chamadas: { sql: string; params: unknown[] }[] = [];
  return {
    chamadas,
    db: {
      query: async (sql: string, params: unknown[]) => {
        chamadas.push({ sql, params });
        return { rows: linhas };
      },
    },
  };
}

const linha = (id: string, atividade: string | null, extra: Partial<Linha> = {}): Linha => ({
  id,
  organization_id: "org-1",
  pipeline_id: "funil-vendas",
  last_activity_at: atividade === null ? null : new Date(atividade),
  created_at: new Date("2026-10-01T22:14:27Z"),
  funil: "Vendas",
  etapa: "1. Entrada Lead",
  ...extra,
});

describe("negocioDoContato", () => {
  it("um negócio aberto: devolve id, funil e etapa", async () => {
    const { db } = dbFalso([linha("negocio-aa12", null)]);
    expect(await negocioDoContato(db as never, "org-1", "contato-9c9e")).toEqual({
      id: "negocio-aa12",
      funil: "Vendas",
      etapa: "1. Entrada Lead",
    });
  });

  it("nenhum negócio aberto: devolve null", async () => {
    const { db } = dbFalso([]);
    expect(await negocioDoContato(db as never, "org-1", "contato-9c9e")).toBeNull();
  });

  it("dois abertos: vence o de atividade mais recente (a regra do roteamento)", async () => {
    const { db } = dbFalso([
      linha("negocio-antigo", "2026-09-01T10:00:00Z"),
      linha("negocio-recente", "2026-10-01T10:00:00Z", { funil: "Pedidos", etapa: null }),
    ]);
    expect(await negocioDoContato(db as never, "org-1", "contato-9c9e")).toEqual({
      id: "negocio-recente",
      funil: "Pedidos",
      etapa: null,
    });
  });

  it("dois abertos empatados: não adivinha — devolve aviso sem id", async () => {
    const { db } = dbFalso([
      linha("negocio-a", "2026-10-01T10:00:00Z"),
      linha("negocio-b", "2026-10-01T10:00:00Z"),
    ]);
    const r = await negocioDoContato(db as never, "org-1", "contato-9c9e");
    expect(r).toMatchObject({ id: null });
    expect((r as { aviso: string }).aviso).toContain("mais de um negócio aberto");
  });

  it("a consulta filtra organização e contato, e só negócios abertos", async () => {
    const { db, chamadas } = dbFalso([]);
    await negocioDoContato(db as never, "org-1", "contato-9c9e");
    expect(chamadas[0]!.params).toEqual(["org-1", "contato-9c9e"]);
    expect(chamadas[0]!.sql).toContain("l.organization_id = $1");
    expect(chamadas[0]!.sql).toContain("l.contact_id = $2");
    expect(chamadas[0]!.sql).toContain("l.status = 'open'");
  });
});
```

- [ ] **Passo 2: Rodar e ver falhar**

Rodar: `npx vitest run tests/unit/negocio-do-contato.test.ts`
Esperado: FALHA — `Failed to resolve import "@/lib/agent-engine/edge/crm/negocio-do-contato"`.

- [ ] **Passo 3: Implementação mínima**

`lib/agent-engine/edge/crm/negocio-do-contato.ts`:

```ts
/**
 * O NEGÓCIO DA PESSOA — o id que as ferramentas do CRM querem em `lead_id`.
 *
 * O contexto do turno sempre chamou o CONTATO de `lead_id` (issue #509), e o
 * modelo acreditava no nome: mandava o id da pessoa para `crm_update_lead`, que
 * espera o id do NEGÓCIO. O portão de escopo não achava negócio, recusava com
 * `escopo_de_funil:indisponivel`, e nenhum campo do card era gravado. Medido em
 * produção em 2026-10-01: nenhuma chamada do agente gravou.
 *
 * A ESCOLHA não nasce aqui: é `resolveActiveLeadForContact`, a mesma do
 * roteamento de atividade e do portão (`lib/ai/runtime/tools.ts`), também sem
 * `defaultPipelineId`. Se as duas divergissem, o contexto diria um negócio e o
 * portão autorizaria outro.
 */
import type { Queryable } from '../../queue/queue';
import { resolveActiveLeadForContact, type LeadCandidate } from '@/lib/leads/active-lead';

/** `{ id: null, aviso }` = há negócio, mas não dá para saber qual: não adivinhar. */
export type NegocioNoContexto =
  | { id: string; funil: string; etapa: string | null }
  | { id: null; aviso: string };

type LinhaDoNegocio = {
  id: string;
  organization_id: string;
  pipeline_id: string;
  last_activity_at: Date | string | null;
  created_at: Date | string;
  funil: string;
  etapa: string | null;
};

const SQL_NEGOCIOS_ABERTOS = `select l.id, l.organization_id, l.pipeline_id, l.last_activity_at, l.created_at,
       p.name as funil, s.name as etapa
  from crm_leads l
  join crm_pipelines p on p.id = l.pipeline_id and p.organization_id = l.organization_id
  left join crm_stages s on s.id = l.stage_id and s.organization_id = l.organization_id
 where l.organization_id = $1 and l.contact_id = $2 and l.status = 'open'`;

/** O pg devolve `timestamptz` como Date; a regra compara ISO. */
function paraIso(valor: Date | string): string {
  return new Date(valor).toISOString();
}

export async function negocioDoContato(
  db: Queryable,
  tenantId: string,
  contactId: string,
): Promise<NegocioNoContexto | null> {
  const { rows } = await db.query<LinhaDoNegocio>(SQL_NEGOCIOS_ABERTOS, [tenantId, contactId]);
  const candidatos: LeadCandidate[] = rows.map((r) => ({
    id: r.id,
    organization_id: r.organization_id,
    pipeline_id: r.pipeline_id,
    status: 'open',
    last_activity_at: r.last_activity_at === null ? null : paraIso(r.last_activity_at),
    created_at: paraIso(r.created_at),
  }));

  const escolha = resolveActiveLeadForContact(candidatos);
  if (escolha.routed) {
    const linha = rows.find((r) => r.id === escolha.leadId);
    return linha ? { id: linha.id, funil: linha.funil, etapa: linha.etapa } : null;
  }
  if (escolha.reason === 'ambiguous_open_leads') {
    return {
      id: null,
      aviso:
        'Esta pessoa tem mais de um negócio aberto e não dá para saber qual é o desta conversa. ' +
        'Não grave nada em negócio neste turno.',
    };
  }
  return null;
}
```

- [ ] **Passo 4: Rodar e ver passar**

Rodar: `npx vitest run tests/unit/negocio-do-contato.test.ts`
Esperado: 5 passed.

- [ ] **Passo 5: Commit (só com OK do usuário)**

```bash
git add lib/agent-engine/edge/crm/negocio-do-contato.ts tests/unit/negocio-do-contato.test.ts
git commit -m "fix(agente): descobre o negócio aberto do contato para o lead_id"
```

---

### Tarefa 2: O contexto do Conversador traz o negócio

**Arquivos:**
- Alterar: `lib/agent-engine/edge/crm/get-lead-context.ts` (interface `LeadContext` ~linha 77-90; montagem do contexto ~linha 266-290)
- Teste: `tests/unit/contexto-do-agente-traz-o-negocio.test.ts`

**Interfaces:**
- Consome: `negocioDoContato`, `NegocioNoContexto` (Tarefa 1).
- Produz: `LeadContext.negocio?: NegocioNoContexto | null` (sempre preenchido por `getLeadContext`).

- [ ] **Passo 1: Escrever o teste que falha**

`tests/unit/contexto-do-agente-traz-o-negocio.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { getLeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";
import { projetarContexto } from "@/lib/agent-engine/agent/projecao";

/**
 * O PRODUTOR entrega o negócio. Sem ele o modelo só tinha o id da PESSOA
 * (`lead_id`, issue #509) e o usava onde o CRM pede o do card.
 */
function dbFalso(negocios: unknown[]) {
  return {
    query: async (sql: string) => {
      if (sql.includes("from contacts")) {
        return {
          rows: [
            {
              name: "Régis",
              display_name: null,
              email: null,
              phone_number: "+5516900000000",
              tags: [],
              is_blocked: false,
              source: "whatsapp",
              consent: null,
              is_anonymized: false,
            },
          ],
        };
      }
      if (sql.includes("from crm_leads l")) return { rows: negocios };
      return { rows: [] };
    },
  };
}

const KNOBS = { historyLimit: 20, maxTokens: 1_000 };
const ENTRADA = { tenantId: "org-1", leadId: "contato-9c9e", fuso: "America/Sao_Paulo" };
const NEGOCIO = {
  id: "negocio-aa12",
  organization_id: "org-1",
  pipeline_id: "funil-vendas",
  last_activity_at: null,
  created_at: new Date("2026-10-01T22:14:27Z"),
  funil: "Vendas",
  etapa: "1. Entrada Lead",
};

describe("o contexto do agente traz o negócio", () => {
  it("com negócio aberto: negocio.id é o do card, e lead_id continua o da pessoa", async () => {
    const r = await getLeadContext(dbFalso([NEGOCIO]) as never, {} as never, ENTRADA, KNOBS);
    if (!r.ok) throw new Error("contexto não montou");
    expect(r.context.negocio).toEqual({ id: "negocio-aa12", funil: "Vendas", etapa: "1. Entrada Lead" });
    // Não renomeia: lead_id circula por outros caminhos (issue #509).
    expect(r.context.lead_id).toBe("contato-9c9e");
    expect(r.context.contact_id).toBe("contato-9c9e");
  });

  it("sem negócio aberto: a chave existe e vale null (ausente seria 'esqueceram de olhar')", async () => {
    const r = await getLeadContext(dbFalso([]) as never, {} as never, ENTRADA, KNOBS);
    if (!r.ok) throw new Error("contexto não montou");
    expect("negocio" in r.context).toBe(true);
    expect(r.context.negocio).toBeNull();
  });

  it("a projeção não deixa o id do negócio chegar ao modelo sem ferramentas", async () => {
    const r = await getLeadContext(dbFalso([NEGOCIO]) as never, {} as never, ENTRADA, KNOBS);
    if (!r.ok) throw new Error("contexto não montou");
    expect(JSON.stringify(projetarContexto(r.context))).not.toContain("negocio-aa12");
  });
});
```

- [ ] **Passo 2: Rodar e ver falhar**

Rodar: `npx vitest run tests/unit/contexto-do-agente-traz-o-negocio.test.ts`
Esperado: FALHA nos 2 primeiros (`expected undefined to deeply equal {...}` e `expected false to be true`). O 3º passa (a projeção já é allowlist) e fica como guarda.

- [ ] **Passo 3: Implementação mínima**

Em `get-lead-context.ts`, acrescentar o import junto dos demais:

```ts
import { negocioDoContato, type NegocioNoContexto } from './negocio-do-contato';
```

Na interface `LeadContext`, logo depois de `contact_id?: string;`:

```ts
  /**
   * O NEGÓCIO (card do funil) desta pessoa — é ESTE id que as ferramentas do CRM
   * querem em `lead_id` (ver `negocio-do-contato.ts`). `null` = sem negócio
   * aberto; `{ id: null, aviso }` = mais de um e não dá para escolher.
   *
   * Opcional no tipo pelo mesmo motivo de `contact_id`: os fixtures de
   * `tests/invariants/**` são congelados. A produção sempre preenche.
   */
  negocio?: NegocioNoContexto | null;
```

Logo antes de `const context = fitToBudget(`:

```ts
  const negocio = await negocioDoContato(db, input.tenantId, input.leadId);
```

No objeto passado a `fitToBudget`, logo depois de `contact_id: input.leadId,`:

```ts
      negocio,
```

- [ ] **Passo 4: Rodar e ver passar (com os vizinhos)**

Rodar: `npx vitest run tests/unit/contexto-do-agente-traz-o-negocio.test.ts tests/unit/get-lead-context-decisao.test.ts tests/unit/contexto-do-agente-chama-o-cliente-pelo-nome-escolhido.test.ts`
Esperado: todos passam (o dublê do teste vizinho devolve `rows: []` para consulta desconhecida, então lá `negocio` vira `null`).

- [ ] **Passo 5: Commit (só com OK do usuário)**

```bash
git add lib/agent-engine/edge/crm/get-lead-context.ts tests/unit/contexto-do-agente-traz-o-negocio.test.ts
git commit -m "fix(agente): o contexto do turno traz o negócio do contato"
```

---

### Tarefa 3: A abertura do turno ensina a usar `negocio.id`

**Arquivos:**
- Alterar: `lib/agent-engine/agent/inbound-turn.ts` (`buildOpeningMessage`, logo depois da linha `'## Contexto do lead (contato + últimas mensagens)',` ~linha 1464)
- Teste: `tests/unit/abertura-ensina-o-id-do-negocio.test.ts`

**Interfaces:**
- Consome: `LeadContext.negocio` (Tarefa 2); `buildOpeningMessage(previous, leadState, context, notesIndexBlock, projeta = false, ...)`.
- Produz: a linha de instrução no texto da abertura.

- [ ] **Passo 1: Escrever o teste que falha**

`tests/unit/abertura-ensina-o-id-do-negocio.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildOpeningMessage } from "@/lib/agent-engine/agent/inbound-turn";
import type { LeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";

/**
 * Ter o id no JSON não basta: o mesmo JSON tem um campo chamado `lead_id` que é
 * a PESSOA. A abertura diz qual dos dois as ferramentas querem.
 */
function contexto(negocio: LeadContext["negocio"]): LeadContext {
  return {
    lead_id: "contato-9c9e",
    contact_id: "contato-9c9e",
    negocio,
    contact: { name: "Régis", phone: null, email: null, tags: [], is_blocked: false },
    conversation_id: "conv-d881",
    last_human_decision: null,
    messages: [{ direction: "inbound", body: "agora em outubro msm", sent_at: "2026-10-01T20:42:55-03:00" }],
  };
}

const NEGOCIO = { id: "negocio-aa12", funil: "Vendas", etapa: "1. Entrada Lead" };

describe("a abertura ensina o id do negócio", () => {
  it("com negócio: manda usar negocio.id como lead_id, e diz que lead_id do contexto é a pessoa", () => {
    const abertura = buildOpeningMessage(null, null, contexto(NEGOCIO), "sem notas", false);
    expect(abertura).toContain('use negocio.id = "negocio-aa12"');
    expect(abertura).toContain("são o ID da PESSOA");
  });

  it("sem negócio: não instrui nada", () => {
    const abertura = buildOpeningMessage(null, null, contexto(null), "sem notas", false);
    expect(abertura).not.toContain("use negocio.id");
  });

  it("projetado (turno sem ferramentas): o id do negócio não aparece em lugar nenhum", () => {
    const abertura = buildOpeningMessage(null, null, contexto(NEGOCIO), "sem notas", true);
    expect(abertura).not.toContain("negocio-aa12");
  });
});
```

- [ ] **Passo 2: Rodar e ver falhar**

Rodar: `npx vitest run tests/unit/abertura-ensina-o-id-do-negocio.test.ts`
Esperado: FALHA no 1º (`expected ... to contain 'use negocio.id = "negocio-aa12"'`). Os outros dois passam e ficam como guarda.

- [ ] **Passo 3: Implementação mínima**

Em `buildOpeningMessage`, logo depois de `'## Contexto do lead (contato + últimas mensagens)',`:

```ts
    // O contexto chama a PESSOA de `lead_id` (issue #509) e o modelo acreditava:
    // mandava esse id para `crm_update_lead`, que quer o NEGÓCIO, e nada era
    // gravado no card. Só quando o contexto vai cru — projetado, `negocio` nem
    // chega ao modelo, e citar o id aqui seria vazá-lo por outra porta.
    ...(!projeta && context.negocio?.id
      ? [
          `Para as ferramentas do CRM que pedem lead_id (consultar, atualizar campos ou mover o negócio), use negocio.id = "${context.negocio.id}". ` +
            'Os campos lead_id e contact_id deste contexto são o ID da PESSOA e não servem para essas ferramentas.',
        ]
      : []),
```

- [ ] **Passo 4: Rodar e ver passar (com os vizinhos)**

Rodar: `npx vitest run tests/unit/abertura-ensina-o-id-do-negocio.test.ts tests/unit/mensagem-atual-prioritaria.test.ts tests/unit/entrega-de-capacidade.test.ts tests/unit/mensagem-que-tem-texto-nao-chega-vazia.test.ts tests/unit/rajada-nao-cala-o-pedido-de-humano.test.ts`
Esperado: todos passam.

- [ ] **Passo 5: Commit (só com OK do usuário)**

```bash
git add lib/agent-engine/agent/inbound-turn.ts tests/unit/abertura-ensina-o-id-do-negocio.test.ts
git commit -m "fix(agente): a abertura do turno manda usar negocio.id como lead_id"
```

---

### Tarefa 4: O Operador recebe os IDs

**Arquivos:**
- Alterar: `lib/agent-engine/agent/operator-turn.ts` (`renderBriefingDoOperador` ~linha 110-140; chamada ~linha 470)
- Teste: `tests/unit/operador-recebe-os-ids.test.ts`

**Interfaces:**
- Consome: `negocioDoContato`, `NegocioNoContexto` (Tarefa 1).
- Produz:
  - `export interface AlvosDoOperador { contactId: string; conversationId: string | null; negocio: NegocioNoContexto | null }`
  - `export function linhasDosAlvos(a: AlvosDoOperador): string[]`
  - `renderBriefingDoOperador(declaracao, promessas, agoraBlock = '', alvos?: AlvosDoOperador)` — 4º parâmetro opcional; chamadores antigos não mudam.

- [ ] **Passo 1: Escrever o teste que falha**

`tests/unit/operador-recebe-os-ids.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { renderBriefingDoOperador } from "@/lib/agent-engine/agent/operator-turn";

/**
 * O Operador grava no CRM, mas o briefing dele não tinha ID nenhum: ele chamava
 * `crm_get_lead` com `00000000-0000-0000-0000-000000000000` (medido em
 * produção, 2026-10-01). Sem o id, a mão dele no CRM era decorativa.
 */
const ALVOS = {
  contactId: "contato-9c9e",
  conversationId: "conv-d881",
  negocio: { id: "negocio-aa12", funil: "Vendas", etapa: "1. Entrada Lead" },
};

describe("o briefing do Operador traz os IDs", () => {
  it("com negócio: contact_id, conversation_id e o lead_id do negócio", () => {
    const texto = renderBriefingDoOperador(null, [], "", ALVOS);
    expect(texto).toContain("contact_id (a pessoa): contato-9c9e");
    expect(texto).toContain("conversation_id: conv-d881");
    expect(texto).toContain("lead_id do negócio");
    expect(texto).toContain("negocio-aa12");
    expect(texto).toContain("Nunca use o contact_id onde a ferramenta pede lead_id.");
  });

  it("sem negócio aberto: diz que não há card, e não inventa lead_id", () => {
    const texto = renderBriefingDoOperador(null, [], "", { ...ALVOS, negocio: null });
    expect(texto).toContain("não tem negócio aberto");
    expect(texto).not.toContain("lead_id do negócio");
  });

  it("ambíguo: repassa o aviso, sem id", () => {
    const aviso = "Esta pessoa tem mais de um negócio aberto e não dá para saber qual é o desta conversa.";
    const texto = renderBriefingDoOperador(null, [], "", { ...ALVOS, negocio: { id: null, aviso } });
    expect(texto).toContain(aviso);
    expect(texto).not.toContain("lead_id do negócio");
  });

  it("sem alvos (assinatura antiga): nada muda", () => {
    expect(renderBriefingDoOperador(null, [])).not.toContain("Identificadores para as ferramentas");
  });

  it("o turno de produção resolve o negócio e passa os alvos", () => {
    // Guarda do call site: a função certa que ninguém chama não protege nada.
    const fonte = readFileSync(resolve(__dirname, "../../lib/agent-engine/agent/operator-turn.ts"), "utf8");
    expect(fonte).toMatch(/negocioDoContato\(pool, tenantId, leadId\)/);
    expect(fonte).toMatch(/contactId: leadId/);
  });
});
```

- [ ] **Passo 2: Rodar e ver falhar**

Rodar: `npx vitest run tests/unit/operador-recebe-os-ids.test.ts`
Esperado: FALHA nos testes 1, 2, 3 e 5 (texto sem os IDs; fonte sem `negocioDoContato`).

- [ ] **Passo 3: Implementação mínima**

Em `operator-turn.ts`, import junto dos demais:

```ts
import { negocioDoContato, type NegocioNoContexto } from '../edge/crm/negocio-do-contato';
```

Logo antes de `export function renderBriefingDoOperador(`:

```ts
/**
 * Os IDs que as ferramentas do Operador pedem. O briefing não trazia nenhum, e o
 * modelo preenchia `lead_id`/`conversation_id` com `00000000-…` (medido em
 * produção, 2026-10-01): toda chamada de CRM dele falhava.
 *
 * Aqui IDs podem aparecer: este papel não tem canal, o texto nunca chega a um
 * cliente (ver `SYSTEM_DO_OPERADOR`).
 */
export interface AlvosDoOperador {
  contactId: string;
  conversationId: string | null;
  negocio: NegocioNoContexto | null;
}

export function linhasDosAlvos(a: AlvosDoOperador): string[] {
  const linhas = ['Identificadores para as ferramentas:', `- contact_id (a pessoa): ${a.contactId}`];
  if (a.conversationId !== null) linhas.push(`- conversation_id: ${a.conversationId}`);
  if (a.negocio === null) {
    linhas.push('- negócio: esta pessoa não tem negócio aberto; não há card para atualizar.');
  } else if (a.negocio.id === null) {
    linhas.push(`- negócio: ${a.negocio.aviso}`);
  } else {
    const etapa = a.negocio.etapa === null ? '' : `, etapa "${a.negocio.etapa}"`;
    linhas.push(
      `- lead_id do negócio (use em crm_get_lead, crm_update_lead, crm_move_lead_stage): ${a.negocio.id} — funil "${a.negocio.funil}"${etapa}`,
    );
  }
  linhas.push('Nunca use o contact_id onde a ferramenta pede lead_id.');
  return linhas;
}
```

Na assinatura de `renderBriefingDoOperador`, acrescentar o 4º parâmetro:

```ts
export function renderBriefingDoOperador(
  declaracao: DeclaracaoDoTurno | null,
  promessas: ReturnType<typeof promessasEmAberto>,
  agoraBlock = '',
  /** Opcional: chamadores de teste montam o briefing sem IDs, e não precisam mudar. */
  alvos?: AlvosDoOperador,
): string {
```

E trocar o `comAgora` existente:

```ts
  const comAgora = (linhas: string[]): string =>
    (agoraBlock === '' ? linhas : [agoraBlock, '', ...linhas]).join('\n');
```

por:

```ts
  const comAgora = (linhas: string[]): string => {
    const comIds = alvos === undefined ? linhas : [...linhas, '', ...linhasDosAlvos(alvos)];
    return (agoraBlock === '' ? comIds : [agoraBlock, '', ...comIds]).join('\n');
  };
```

No turno (~linha 466), dentro de `if (mcp !== null) {` e antes de `saida = await runModelCall(`:

```ts
        // O negócio da pessoa, pela MESMA regra do contexto do Conversador e do
        // portão de escopo — sem ele o Operador mandava `00000000-…` como lead_id.
        const negocio = await negocioDoContato(pool, tenantId, leadId);
        log.info('operador: negócio do contato', {
          negocio: negocio === null ? 'nenhum' : negocio.id === null ? 'ambiguo' : 'unico',
        });
```

E na chamada `renderBriefingDoOperador(declaracao, promessas, renderAgora(...))`, acrescentar o 4º argumento depois de `renderAgora(...)`:

```ts
                  { contactId: leadId, conversationId: payload.conversation_id ?? null, negocio },
```

- [ ] **Passo 4: Rodar e ver passar (com o vizinho)**

Rodar: `npx vitest run tests/unit/operador-recebe-os-ids.test.ts tests/unit/operador-nao-tem-canal.test.ts`
Esperado: todos passam.

- [ ] **Passo 5: Commit (só com OK do usuário)**

```bash
git add lib/agent-engine/agent/operator-turn.ts tests/unit/operador-recebe-os-ids.test.ts
git commit -m "fix(operador): o briefing traz contact_id, conversation_id e o negócio"
```

---

### Tarefa 5: Fragmento de release, validação completa e prova de que os testes guardam

**Arquivos:**
- Criar: `.changes/agente-grava-no-negocio-certo.md`

- [ ] **Passo 1: Escrever o fragmento**

`.changes/agente-grava-no-negocio-certo.md`:

```markdown
---
impacto: nada_mudou
secao: corrigido
titulo: O agente passa a gravar o que coleta nos campos do negócio
---

O agente de IA agora recebe o identificador do negócio (o card do funil) de cada
pessoa e grava nos campos personalizados do funil o que coleta na conversa.
Antes, ele usava o identificador do contato, o CRM recusava a gravação e os
campos do negócio ficavam vazios.

Para funcionar, o funil precisa estar liberado para o agente em
**Agente de IA › Agentes › (seu agente) › Em que negócios ele pode mexer**.
```

- [ ] **Passo 2: Validação completa**

```bash
npm run typecheck
npm run lint
npx vitest run tests/unit/negocio-do-contato.test.ts \
  tests/unit/contexto-do-agente-traz-o-negocio.test.ts \
  tests/unit/abertura-ensina-o-id-do-negocio.test.ts \
  tests/unit/operador-recebe-os-ids.test.ts \
  tests/unit/get-lead-context-decisao.test.ts \
  tests/unit/contexto-do-agente-chama-o-cliente-pelo-nome-escolhido.test.ts \
  tests/unit/mensagem-atual-prioritaria.test.ts \
  tests/unit/operador-nao-tem-canal.test.ts \
  tests/unit/ponte-do-agente-passa-o-escopo.test.ts
pnpm release:conferir
```

Esperado: typecheck e lint zerados; todos os testes passam; `release:conferir` aceita o fragmento.
`tests/invariants/service-boundary.test.ts` chama `getLeadContext` contra banco real (vitest.db.config) — rodar se houver banco local; senão, declarar como NÃO medido.

- [ ] **Passo 3: Sabotagem (teste que não reprova não guarda nada)**

Uma de cada vez, desfazendo depois de cada uma:
1. Em `get-lead-context.ts`, apagar a linha `negocio,` → `contexto-do-agente-traz-o-negocio` tem de ficar VERMELHO.
2. Em `inbound-turn.ts`, trocar `!projeta && context.negocio?.id` por `false` → `abertura-ensina-o-id-do-negocio` VERMELHO.
3. Em `operator-turn.ts`, remover o 4º argumento do `renderBriefingDoOperador` → `operador-recebe-os-ids` VERMELHO (guarda do call site).

Conferir com `git diff` que as três sabotagens foram desfeitas.

- [ ] **Passo 4: Revisão**

`/code-review` nas mudanças locais, mais os agentes `typescript-reviewer`, `silent-failure-hunter` e `security-reviewer` (foco: a consulta nova filtra `organization_id`). Corrigir CRITICAL/HIGH.

- [ ] **Passo 5: Commit do fragmento e PR (só com OK do usuário)**

```bash
git add .changes/agente-grava-no-negocio-certo.md
git commit -m "docs(release): fragmento do agente gravando no negócio certo"
```

PR via `/pr`, seguindo a skill `deskcomm-contribuir` (o `repo/` é clone de `melgarafael/DeskcommCRM`). Corpo do PR: o porquê medido (nenhuma chamada do agente gravou), as 4 mudanças, o que NÃO foi medido, destino = núcleo.

---

## Fora deste plano

- **Lista de campos válidos do funil no contexto** (o agente ainda pode inventar chaves como `utilizou_eps`): melhoria separada; até lá, o bloco de chaves no prompt do agente cobre.
- **Rede de segurança no portão** (`lib/ai/runtime/tools.ts`) trocando ID de contato por negócio: desnecessária se este plano funcionar; reavaliar depois de medir em produção.
- **Chegar à VPS**: depende do merge do PR e de atualizar a instalação.

## Como medir em produção depois do deploy

```sql
select metadata->>'success' as ok, metadata->>'error' as erro, count(*)
from api_audit_log
where action = 'mcp.tool_called' and metadata->>'tool_name' = 'crm_update_lead'
  and metadata->>'actor_type' = 'ai_agent' and created_at > now() - interval '1 day'
group by 1, 2;
```

Esperado: `ok = true` dominante, sem `escopo_de_funil:indisponivel`.
