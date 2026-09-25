# Grupos de WhatsApp na inbox: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** grupos de WhatsApp escolhidos por número aparecem na inbox, com histórico e resposta
manual pelos atendentes; a IA nunca responde.

**Architecture:** uma lista de grupos permitidos por sessão (`channel_session_groups`) decide o
que a entrada aceita. A mensagem aceita entra em `conversations`/`messages` com `is_group = true`
e um "contato do grupo" (`contacts.kind = 'whatsapp_group'`). O banco para de rotear grupo e
emite `message.group_received`, e não `message.received`, para conversa de grupo: todos os
consumidores atuais ficam de fora por construção. O filtro `ignore.groups` do WAHA passa a ser
propriedade desta funcionalidade.

**Tech Stack:** Next.js 16 route handlers, Supabase (Postgres + RLS), WAHA NOWEB, Vitest,
`pnpm test:db` (Postgres real), React 19.

**Spec:** `docs/superpowers/specs/2026-09-23-grupos-na-inbox-design.md`

## Global Constraints

- Toda tabela nova: `organization_id uuid not null references organizations(id) on delete cascade` + RLS `tenant_isolation_<tabela>_all` via `fn_user_org_ids()`.
- Service role (admin client) filtra `organization_id` manualmente, vindo de fonte confiável, **nunca do body**. A trava `tests/unit/admin-client-filtra-organizacao.test.ts` reprova consulta nova sem filtro.
- Schema em tripla: migration em `supabase/migrations/` + apêndice idempotente no fim de `supabase/baseline.sql` + linha em `supabase/migrations/MANIFEST.md`.
- Função nova ou recriada em `public` termina com `revoke execute ... from public, anon;` + `grant` só a quem precisa. Ao recriar uma função existente, repita exatamente os grants que ela tinha.
- Ler função do baseline pela **última** definição (`rfind`), nunca pela primeira.
- Nenhuma feature nomeia provider fora de `lib/channels/` (`pnpm lint:channels`).
- `type` é `text` + `check`, não enum.
- Sem `console.log` novo; use `logger`.
- Mutação POST/PATCH/PUT bem-sucedida grava 1 linha em `api_audit_log` via `audit()`.
- Zod em todo input externo.
- `pnpm test:unit` é a suíte inteira (sem caminho); não corte a saída com `tail`.
- A IA **nunca** responde em grupo; nenhum consumidor de `message.received` pode receber mensagem de grupo.

## Mapa de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/<ts>_<NNNN>_grupos_na_inbox.sql` (novo) | Tabela, coluna `kind`, guarda no roteamento, evento de grupo |
| `supabase/baseline.sql` (apêndice) | O mesmo, idempotente |
| `supabase/migrations/MANIFEST.md` | Linha da migration |
| `tests/invariants/grupos-na-inbox.test.ts` (novo) | RLS, default de `kind`, roteamento pula grupo, evento de grupo |
| `lib/messaging/remetente-de-grupo.ts` (novo) | Schema Zod único de `metadata.group_sender` |
| `lib/waha/client.ts` | `groups` tolerado e preservado; `listarGrupos`; `definirRecebimentoDeGrupos` |
| `lib/channels/types.ts`, `lib/channels/adapters/waha.ts` | `listGroups?` e `setGroupIntake?` no adapter |
| `lib/grupos/servico.ts` (novo) | Listar e ligar/desligar grupo, com pós-condição e audit |
| `lib/grupos/ingest.ts` (novo) | Gravar mensagem de grupo aceita |
| `lib/waha/ingest.ts` | Desvio para `lib/grupos/ingest.ts` quando `@g.us` |
| `app/api/v1/channel-sessions/[id]/groups/route.ts` (novo) | GET lista, PUT liga/desliga |
| `lib/notifications/push.handler.ts` | Escuta `message.group_received` |
| `app/api/v1/contacts/_handler.ts`, `lib/campanhas/consulta-de-audiencia.ts` | Excluem `kind = 'whatsapp_group'` |
| `components/connections/GruposSheet.tsx` (novo) + `ConnectionsClient.tsx` | Tela de ligar grupos |
| `components/inbox/ConversationListItem.tsx`, `MessageBubble.tsx`, `InboxFilters.tsx` | Etiqueta, remetente, filtro |
| `.changes/grupos-na-inbox.md` (novo), `CLAUDE.md` (seção WAHA) | Nota pública e doutrina |

---

### Task 0: Sonda do WAHA real (antes de codar contra ele)

O formato de `GET /api/{session}/groups` e o efeito de `PUT /api/sessions/{name}` com
`ignore.groups` numa sessão **em execução** não estão medidos neste repositório. A sonda os
mede, e o resultado vira fixture dos testes da Task 3.

**Files:**
- Create: `lib/waha/__fixtures__/grupos-noweb-2026.7.2.json`

- [ ] **Step 1: Com o ambiente local no ar e o número de teste conectado, ler a API key e o nome da sessão**

```bash
grep -E '^WAHA_API_KEY=' .env.local | cut -d= -f1   # só confere que existe; não imprima o valor
docker exec deskcommcrm-waha-1 sh -c 'wget -qO- --header "X-Api-Key: $WAHA_API_KEY_PLAIN" http://127.0.0.1:3000/api/sessions' | head -c 600
```

Se `WAHA_API_KEY_PLAIN` não existir no contêiner, use a chave em texto do `.env.local` numa variável de shell, sem ecoá-la.

- [ ] **Step 2: Gravar a lista de grupos crua (o dono do número precisa estar em pelo menos um grupo de teste)**

```bash
S=<nome-da-sessao>
node -e 'fetch(`http://127.0.0.1:3030/api/'"$S"'/groups`,{headers:{"X-Api-Key":process.env.K}}).then(r=>r.json()).then(j=>require("fs").writeFileSync("lib/waha/__fixtures__/grupos-noweb-2026.7.2.json",JSON.stringify(Array.isArray(j)?j.slice(0,3):j,null,2)))'
```

Antes de commitar, troque na fixture os nomes reais de grupos e os números de participantes por valores fictícios (`Grupo de Teste`, `5500000000000`). **Nenhum dado pessoal em fixture.**

- [ ] **Step 3: Medir o PUT do filtro numa sessão em execução**

Leia `GET /api/sessions/{S}`, faça `PUT /api/sessions/{S}` com `config.ignore.groups=false` preservando o resto do `config`, leia de novo e anote: (a) o GET reflete `false`? (b) o status continua `WORKING` ou exige restart? (c) uma mensagem enviada ao grupo de teste chega ao webhook (`docker compose logs app | grep g.us`)? Depois volte `groups=true` e confirme pelo GET.

Registre as três respostas no cabeçalho da fixture como comentário no JSON (campo `"_medido"`). A Task 3 depende delas: se exigir restart, `definirRecebimentoDeGrupos` chama `startExistingSession` depois do PUT.

- [ ] **Step 4: Commit**

```bash
git add lib/waha/__fixtures__/grupos-noweb-2026.7.2.json
git commit -m "test(waha): fixture medida de grupos e do filtro ignore.groups no NOWEB 2026.7.2"
```

---

### Task 1: Migration (tabela, `contacts.kind`, roteamento e evento)

**Files:**
- Create: `supabase/migrations/<ts>_<NNNN>_grupos_na_inbox.sql`
- Modify: `supabase/baseline.sql` (apêndice no fim)
- Modify: `supabase/migrations/MANIFEST.md`
- Test: `tests/invariants/grupos-na-inbox.test.ts`

**Interfaces:**
- Produces: tabela `public.channel_session_groups(id, organization_id, channel_session_id, group_chat_id, subject, enabled, enabled_at, enabled_by_user_id, contact_id, conversation_id, created_at, updated_at)`; coluna `public.contacts.kind text not null default 'person'` com `check (kind in ('person','whatsapp_group'))`; evento `message.group_received` com o mesmo payload de `message.received`.

- [ ] **Step 1: Escolher o número da migration**

```bash
pnpm checar:colisao-de-migration
ls supabase/migrations/ | grep -oE '_[0-9]{4}_' | tr -d _ | sort -n | tail -1
```

Use o próximo `NNNN` livre (em 23/09/2026 o maior era `0387`) e um timestamp `YYYYMMDDHHMMSS` atual.

- [ ] **Step 2: Escrever o teste de invariante (falha: tabela e coluna não existem)**

```ts
// tests/invariants/grupos-na-inbox.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  seedGov,
  GOV_ORG as org,
  GOV_MANAGER as manager,
  GOV_AGENT_A as agente,
  GOV_SESSION as sessao,
} from "./gov-helpers";

const pool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`, max: 4 });
const q = (t: string, a: unknown[] = []) => pool.query(t, a);
async function comoUsuario(user: string, text: string, args: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query("begin"); await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, aal: "aal1" })]);
    const r = await c.query(text, args); await c.query("commit"); return r;
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}
const OUTRA_ORG = "dddddddd-0000-4000-8000-000000000001";
const GRUPO = "120363000000000001@g.us";

beforeAll(async () => {
  await seedGov();
  await q("insert into organizations(id,name,slug) values($1,'Outra','outra-grupos') on conflict do nothing", [OUTRA_ORG]);
});
afterAll(() => pool.end());

describe("contacts.kind", () => {
  it("contato existente e novo nascem 'person'; valor fora do vocabulário é recusado", async () => {
    const r = await q("select count(*)::int n from contacts where kind <> 'person'");
    expect(r.rows[0].n).toBe(0);
    await expect(q("update contacts set kind='outro' where organization_id=$1", [org])).rejects.toThrow(/check/i);
  });
});

describe("channel_session_groups", () => {
  it("isola por organização (RLS) e só gerente escreve", async () => {
    await q("delete from channel_session_groups where organization_id=$1", [org]);
    await comoUsuario(manager, "insert into channel_session_groups(organization_id,channel_session_id,group_chat_id,subject) values($1,$2,$3,'Teste')", [org, sessao, GRUPO]);
    await expect(
      comoUsuario(agente, "insert into channel_session_groups(organization_id,channel_session_id,group_chat_id) values($1,$2,'x@g.us')", [org, sessao]),
    ).rejects.toThrow();
    const daOutra = await comoUsuario(manager, "select count(*)::int n from channel_session_groups where organization_id=$1", [OUTRA_ORG]);
    expect(daOutra.rows[0].n).toBe(0);
    const doAgente = await comoUsuario(agente, "select count(*)::int n from channel_session_groups where organization_id=$1", [org]);
    expect(doAgente.rows[0].n).toBe(1);
  });
});

describe("conversa de grupo no banco", () => {
  async function conversaDeGrupo() {
    const c = await q(
      "insert into contacts(organization_id,name,display_name,kind,source) values($1,'Grupo Teste','Grupo Teste','whatsapp_group','whatsapp_group') returning id",
      [org],
    );
    const conv = await q(
      "insert into conversations(organization_id,contact_id,channel_session_id,channel,status,is_group,group_chat_id) values($1,$2,$3,'whatsapp','open',true,$4) returning id",
      [org, c.rows[0].id, sessao, GRUPO],
    );
    return { contato: c.rows[0].id as string, conversa: conv.rows[0].id as string };
  }

  it("conversa de grupo nova NÃO pede roteamento", async () => {
    const { conversa } = await conversaDeGrupo();
    const r = await q("select count(*)::int n from event_log where organization_id=$1 and entity_id=$2 and event_type='conversation.routing_requested'", [org, conversa]);
    expect(r.rows[0].n).toBe(0);
  });

  it("mensagem recebida em grupo emite message.group_received e nunca message.received", async () => {
    const { contato, conversa } = await conversaDeGrupo();
    const m = await q(
      "insert into messages(organization_id,conversation_id,channel_session_id,contact_id,external_id,type,direction,status,body) values($1,$2,$3,$4,$5,'text','inbound','delivered','oi') returning id",
      [org, conversa, sessao, contato, `grp-${Date.now()}`],
    );
    const tipos = await q("select event_type from event_log where organization_id=$1 and payload->>'message_id'=$2", [org, m.rows[0].id]);
    const nomes = tipos.rows.map((r) => r.event_type);
    expect(nomes).toContain("message.group_received");
    expect(nomes).not.toContain("message.received");
  });

  it("conversa individual continua emitindo message.received (controle)", async () => {
    const conv = await q("select id, contact_id from conversations where organization_id=$1 and is_group=false limit 1", [org]);
    const m = await q(
      "insert into messages(organization_id,conversation_id,channel_session_id,contact_id,external_id,type,direction,status,body) values($1,$2,$3,$4,$5,'text','inbound','delivered','oi') returning id",
      [org, conv.rows[0].id, sessao, conv.rows[0].contact_id, `ind-${Date.now()}`],
    );
    const tipos = await q("select event_type from event_log where organization_id=$1 and payload->>'message_id'=$2", [org, m.rows[0].id]);
    expect(tipos.rows.map((r) => r.event_type)).toContain("message.received");
  });
});
```

Se `seedGov` não criar conversa individual em `GOV_SESSION`, use `GOV_CONV_UNASSIGNED` no terceiro caso, que é uma conversa individual do seed.

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm test:db tests/invariants/grupos-na-inbox.test.ts`
Expected: FAIL (`relation "channel_session_groups" does not exist` / `column "kind" does not exist`).

- [ ] **Step 4: Escrever a migration**

Pegue o corpo **atual** das duas funções pela última definição, para não perder nada:

```bash
python3 -c "
s=open('supabase/baseline.sql',encoding='utf-8').read()
for f in ['fn_request_channel_routing','fn_emit_message_event']:
    import re
    i=[m.start() for m in re.finditer(r'create or replace function \"?public\"?\.\"?%s\"?\s*\('%f,s,re.I)][-1]
    print(s[i:s.index('\$\$;',i)+3]); print()"
grep -nE "(revoke|grant) .*fn_emit_message_event" supabase/baseline.sql | tail -3
```

Conteúdo da migration (idempotente; sem `BEGIN`/`COMMIT`):

```sql
-- Grupos de WhatsApp na inbox: histórico e resposta manual, IA nunca responde.
-- Spec: docs/superpowers/specs/2026-09-23-grupos-na-inbox-design.md

-- 1. O contato que representa um grupo. Todo contato existente vira 'person' pelo default.
alter table public.contacts add column if not exists kind text not null default 'person';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'contacts_kind_check') then
    alter table public.contacts add constraint contacts_kind_check check (kind in ('person','whatsapp_group'));
  end if;
end $$;
create index if not exists idx_contacts_org_kind on public.contacts (organization_id, kind) where kind <> 'person';

-- 2. Os grupos de cada número, com a chave liga/desliga.
create table if not exists public.channel_session_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null references public.channel_sessions(id) on delete cascade,
  group_chat_id text not null check (group_chat_id like '%@g.us'),
  subject text,
  enabled boolean not null default false,
  enabled_at timestamptz,
  enabled_by_user_id uuid references auth.users(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, channel_session_id, group_chat_id)
);
alter table public.channel_session_groups enable row level security;

drop policy if exists tenant_isolation_channel_session_groups_all on public.channel_session_groups;
drop policy if exists channel_session_groups_select on public.channel_session_groups;
drop policy if exists channel_session_groups_write on public.channel_session_groups;
create policy channel_session_groups_select on public.channel_session_groups
  for select using (organization_id in (select public.fn_user_org_ids()));
create policy tenant_isolation_channel_session_groups_all on public.channel_session_groups
  for all using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  ) with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  );

drop trigger if exists trg_channel_session_groups_updated_at on public.channel_session_groups;
create trigger trg_channel_session_groups_updated_at
  before update on public.channel_session_groups
  for each row execute function public.fn_set_updated_at();

-- 3. Roteamento automático não atribui grupo (quebraria a visibilidade por "sem dono").
-- CORPO: copie a última definição de fn_request_channel_routing e acrescente a linha marcada.
create or replace function public.fn_request_channel_routing(p_org uuid,p_conversation uuid)
returns void language plpgsql security definer set search_path=public as $$
declare c public.conversations;
begin
 select * into c from public.conversations where organization_id=p_org and id=p_conversation;
 if not found or c.assigned_to_user_id is not null or c.status not in('open','pending','claimed','ai_handling') then return;end if;
 if c.is_group then return; end if; -- grupos: nunca roteados (migration <NNNN>)
 insert into public.event_log(organization_id,event_type,entity_kind,entity_id,payload)
 values(p_org,'conversation.routing_requested','conversation',c.id,
  jsonb_build_object('organization_id',p_org,'conversation_id',c.id,'channel_session_id',c.channel_session_id))
 on conflict(organization_id,entity_id) where event_type='conversation.routing_requested' and status in('pending','processing')
 do update set next_attempt_at=case when event_log.status='pending' then now() else event_log.next_attempt_at end;
end;
$$;
revoke all on function public.fn_request_channel_routing(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_request_channel_routing(uuid,uuid) to service_role;

-- 4. Mensagem recebida em grupo emite message.group_received: nenhum consumidor de
-- message.received (IA, follow-up, campanhas, automações, webhooks, sentimento) a vê.
create or replace function public.fn_emit_message_event() returns trigger
language plpgsql set search_path to 'public', 'pg_temp' as $$
declare
  v_event text;
begin
  if new.direction = 'inbound' then
    if exists (select 1 from public.conversations c
               where c.id = new.conversation_id and c.organization_id = new.organization_id and c.is_group) then
      v_event := 'message.group_received';
    else
      v_event := 'message.received';
    end if;
  else
    v_event := case new.status
                 when 'sending' then 'message.sending'
                 when 'sent' then 'message.sent'
                 when 'failed' then 'message.failed'
                 else 'message.outbound'
               end;
  end if;

  perform public.fn_log_event(
    new.organization_id, v_event,
    jsonb_build_object(
      'message_id', new.id, 'conversation_id', new.conversation_id,
      'contact_id', new.contact_id, 'direction', new.direction,
      'type', new.type, 'status', new.status, 'external_id', new.external_id,
      'channel_session_id', new.channel_session_id,
      'body_preview', "left"(new.body, 280)
    )
  );
  return new;
end$$;
```

Os grants de `fn_emit_message_event`: repita **exatamente** o que o `grep` do início deste passo mostrou. Se não houver grant explícito, acrescente `revoke execute on function public.fn_emit_message_event() from public, anon;`, porque `tests/invariants/hardening-definer-varredura.test.ts` cobra isso.

Se o `grep` mostrar que `event_log` tem um CHECK de `event_type` ou um vocabulário em `lib/audit/actions.ts` ou `lib/schemas/webhooks.ts`, acrescente `message.group_received` a esse vocabulário. O teste `tests/invariants/vocabulario-banco-x-typescript.test.ts` aponta o que falta.

- [ ] **Step 5: Copiar a migration para o apêndice do baseline**

No fim de `supabase/baseline.sql`, um bloco rotulado com o mesmo conteúdo:

```sql
-- ---- grupos de WhatsApp na inbox (migration <NNNN>) ----
<conteúdo idêntico ao da migration>
```

E a linha no `MANIFEST.md` (tabela "Applied"):

```markdown
| `<ts>` | `<NNNN>_grupos_na_inbox` | **Grupos de WhatsApp na inbox, só os escolhidos.** `channel_session_groups` (lista de permitidos por número, RLS com escrita de gerente), `contacts.kind` (`person`/`whatsapp_group`), roteamento pula grupo, e `fn_emit_message_event` emite `message.group_received` para conversa de grupo — nenhum consumidor de `message.received` vê grupo. Spec `docs/superpowers/specs/2026-09-23-grupos-na-inbox-design.md`. |
```

- [ ] **Step 6: Rodar e ver passar (install + update + invariantes)**

Run: `pnpm test:db tests/invariants/grupos-na-inbox.test.ts`
Expected: PASS nos 5 casos.

Run: `pnpm test:db` (a suíte inteira de invariantes)
Expected: sem falha nova, incluindo `hardening-definer-varredura`, `apendice-do-baseline-nao-diverge-da-cadeia` e `manifest-x-migrations`.

- [ ] **Step 7: Sabotar**

Remova a linha `if c.is_group then return; end if;` do apêndice do baseline. Previsto: 1 vermelho ("conversa de grupo nova NÃO pede roteamento"). Rode, confira e restaure. Depois troque `'message.group_received'` por `'message.received'`. Previsto: 1 vermelho. Restaure.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/*_grupos_na_inbox.sql supabase/baseline.sql supabase/migrations/MANIFEST.md tests/invariants/grupos-na-inbox.test.ts
git commit -m "feat(grupos): schema de grupos na inbox, roteamento e evento separados para grupo"
```

---

### Task 2: Remetente de grupo (schema Zod único)

**Files:**
- Create: `lib/messaging/remetente-de-grupo.ts`
- Test: `lib/messaging/remetente-de-grupo.test.ts`

**Interfaces:**
- Produces: `remetenteDeGrupoSchema` (Zod); `type RemetenteDeGrupo = { name: string | null; phone: string | null; lid: string | null }`; `lerRemetenteDeGrupo(metadata: unknown): RemetenteDeGrupo | null`; `rotuloDoRemetente(r: RemetenteDeGrupo): string`.

- [ ] **Step 1: Teste**

```ts
// lib/messaging/remetente-de-grupo.test.ts
import { describe, expect, it } from "vitest";
import { lerRemetenteDeGrupo, rotuloDoRemetente } from "./remetente-de-grupo";

describe("remetente de grupo", () => {
  it("lê o remetente gravado em metadata.group_sender", () => {
    const r = lerRemetenteDeGrupo({ raw_type: "chat", group_sender: { name: "Maria", phone: "+5521999990000", lid: null } });
    expect(r).toEqual({ name: "Maria", phone: "+5521999990000", lid: null });
  });
  it("devolve null quando não é mensagem de grupo ou o formato é outro", () => {
    expect(lerRemetenteDeGrupo({ raw_type: "chat" })).toBeNull();
    expect(lerRemetenteDeGrupo({ group_sender: "Maria" })).toBeNull();
    expect(lerRemetenteDeGrupo(null)).toBeNull();
  });
  it("rótulo prefere o nome, depois o telefone, depois 'Participante'", () => {
    expect(rotuloDoRemetente({ name: "Maria", phone: "+5521999990000", lid: null })).toBe("Maria · +5521999990000");
    expect(rotuloDoRemetente({ name: null, phone: "+5521999990000", lid: null })).toBe("+5521999990000");
    expect(rotuloDoRemetente({ name: null, phone: null, lid: "123" })).toBe("Participante");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run lib/messaging/remetente-de-grupo.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar**

```ts
// lib/messaging/remetente-de-grupo.ts
/**
 * Quem mandou uma mensagem num grupo de WhatsApp. Mora em `messages.metadata.group_sender`,
 * e ESTE é o único lugar que conhece esse caminho (anti-pattern nº 6: nenhuma tela lê o
 * jsonb direto). Nenhum contato é criado por participante: o remetente é só rótulo.
 */
import { z } from "zod";

export const remetenteDeGrupoSchema = z.strictObject({
  name: z.string().min(1).max(200).nullable(),
  phone: z.string().regex(/^\+\d{8,15}$/).nullable(),
  lid: z.string().regex(/^\d{5,40}$/).nullable(),
});

export type RemetenteDeGrupo = z.infer<typeof remetenteDeGrupoSchema>;

export function lerRemetenteDeGrupo(metadata: unknown): RemetenteDeGrupo | null {
  if (!metadata || typeof metadata !== "object") return null;
  const bruto = (metadata as Record<string, unknown>).group_sender;
  const r = remetenteDeGrupoSchema.safeParse(bruto);
  return r.success ? r.data : null;
}

export function rotuloDoRemetente(r: RemetenteDeGrupo): string {
  if (r.name && r.phone) return `${r.name} · ${r.phone}`;
  return r.name ?? r.phone ?? "Participante";
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm exec vitest run lib/messaging/remetente-de-grupo.test.ts`
Expected: PASS (3).

- [ ] **Step 5: Commit**

```bash
git add lib/messaging/remetente-de-grupo.ts lib/messaging/remetente-de-grupo.test.ts
git commit -m "feat(grupos): schema único do remetente de mensagem de grupo"
```

---

### Task 3: Cliente do WAHA (o filtro `groups` vira desta funcionalidade)

**Files:**
- Modify: `lib/waha/client.ts` (`compatibleSession`, `convergirConfigDaSessao`, `createSession`; novos `listarGrupos` e `definirRecebimentoDeGrupos`)
- Test: `lib/waha/client-grupos.test.ts` (novo, no padrão de servidor HTTP local de `lib/waha/client.test.ts`)

**Interfaces:**
- Consumes: a fixture da Task 0.
- Produces: `WahaClient.listarGrupos(session: string): Promise<Array<{ chatId: string; subject: string | null }>>`; `WahaClient.definirRecebimentoDeGrupos(name: string, receber: boolean): Promise<boolean>` (true só se o GET posterior confirmar `ignore.groups === !receber`); `CHAVES_DO_FILTRO_FIXAS` (as chaves de `CONVERSAS_IGNORADAS` menos `groups`).

- [ ] **Step 1: Testes (servidor HTTP falso)**

```ts
// lib/waha/client-grupos.test.ts
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WahaClient } from "./client";

const fixture = JSON.parse(readFileSync("lib/waha/__fixtures__/grupos-noweb-2026.7.2.json", "utf8"));
let server: Server; let base = "";
let sessao: { name: string; status: string; engine: { engine: string }; config: { ignore: Record<string, boolean>; webhooks: unknown[] } };
let putsRecebidos: unknown[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/groups")) return res.end(JSON.stringify(fixture.grupos ?? fixture));
      if (req.url === "/api/sessions/s1" && req.method === "GET") return res.end(JSON.stringify(sessao));
      if (req.url === "/api/sessions/s1" && req.method === "PUT") {
        const j = JSON.parse(body); putsRecebidos.push(j);
        sessao = { ...sessao, config: j.config }; return res.end(JSON.stringify(sessao));
      }
      if (req.url === "/api/server/version") return res.end(JSON.stringify({ engine: "NOWEB" }));
      res.statusCode = 404; res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  putsRecebidos = [];
  sessao = { name: "s1", status: "WORKING", engine: { engine: "NOWEB" }, config: { ignore: { status: true, broadcast: true, channels: true, groups: true }, webhooks: [] } };
});

const cliente = () => new WahaClient(base, "chave-teste");

describe("grupos no cliente do WAHA", () => {
  it("lista grupos como { chatId, subject } a partir do formato real medido", async () => {
    const grupos = await cliente().listarGrupos("s1");
    expect(grupos.length).toBeGreaterThan(0);
    for (const g of grupos) {
      expect(g.chatId).toMatch(/@g\.us$/);
      expect(typeof g.subject === "string" || g.subject === null).toBe(true);
    }
  });

  it("ligar grupos grava ignore.groups=false preservando o resto do config, e confirma relendo", async () => {
    await expect(cliente().definirRecebimentoDeGrupos("s1", true)).resolves.toBe(true);
    expect(putsRecebidos).toHaveLength(1);
    expect((putsRecebidos[0] as { config: { ignore: Record<string, boolean>; webhooks: unknown } }).config).toMatchObject({
      ignore: { status: true, broadcast: true, channels: true, groups: false },
      webhooks: [],
    });
  });

  it("devolve false quando o WAHA responde 200 mas o GET não reflete a troca", async () => {
    const c = cliente();
    // o servidor falso aceita o PUT; aqui ele passa a ignorá-lo:
    sessao = { ...sessao };
    const original = sessao.config;
    const r = c.definirRecebimentoDeGrupos("s1", true);
    // devolve a config antiga no próximo GET
    setTimeout(() => (sessao = { ...sessao, config: original }), 0);
    await expect(r).resolves.toBe(false);
  });

  it("sessão com groups=false continua compatível e a convergência NÃO a reverte", async () => {
    sessao.config.ignore.groups = false;
    await cliente().convergirConfigDaSessao("s1");
    expect(putsRecebidos).toHaveLength(0);
  });

  it("a convergência ainda corrige as outras chaves e preserva groups", async () => {
    sessao.config.ignore = { status: false, broadcast: true, channels: true, groups: false };
    await cliente().convergirConfigDaSessao("s1");
    expect((putsRecebidos[0] as { config: { ignore: Record<string, boolean> } }).config.ignore).toEqual({
      status: true, broadcast: true, channels: true, groups: false,
    });
  });
});
```

O terceiro caso depende da ordem PUT→GET. Se ficar instável, troque por uma flag `ignorarProximoPut` no servidor falso: o PUT responde 200 sem aplicar. O objetivo do caso é: **200 sem efeito ⇒ `false`**.

Se o construtor de `WahaClient` tiver outra assinatura, copie a de `lib/waha/client.test.ts`.

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run lib/waha/client-grupos.test.ts`
Expected: FAIL (`listarGrupos is not a function`; o quarto caso falha porque a convergência reverte `groups`).

- [ ] **Step 3: Implementar em `lib/waha/client.ts`**

1. Logo abaixo de `CONVERSAS_IGNORADAS`:

```ts
/**
 * As chaves do filtro que o CRM IMPÕE. `groups` fica de fora de propósito: desde a
 * funcionalidade de grupos na inbox, quem decide `groups` é `definirRecebimentoDeGrupos`,
 * a partir de `channel_session_groups`. Compatibilidade e convergência não a tocam.
 */
export const CHAVES_DO_FILTRO_FIXAS = Object.fromEntries(
  Object.entries(CONVERSAS_IGNORADAS).filter(([k]) => k !== "groups"),
) as Omit<typeof CONVERSAS_IGNORADAS, "groups">;
```

2. Em `compatibleSession`, troque `Object.entries(CONVERSAS_IGNORADAS)` por `Object.entries(CHAVES_DO_FILTRO_FIXAS)`.

3. Em `convergirConfigDaSessao`, troque a montagem e a checagem:

```ts
      const ignoreAtual = (typeof sessao.config.ignore === "object" && sessao.config.ignore !== null
        ? sessao.config.ignore
        : {}) as Record<string, unknown>;
      const groupsAtual = typeof ignoreAtual.groups === "boolean" ? ignoreAtual.groups : CONVERSAS_IGNORADAS.groups;
      const config = { ...sessao.config, ignore: { ...CHAVES_DO_FILTRO_FIXAS, groups: groupsAtual } };
      const jaConvergida = Object.entries(CHAVES_DO_FILTRO_FIXAS).every(([k, v]) => ignoreAtual[k] === v);
      if (jaConvergida) return;
```

4. Em `startExistingSession` (linha ~263), a expressão `filtersCurrent` passa a usar `CHAVES_DO_FILTRO_FIXAS`.

5. `createSession` continua criando com `CONVERSAS_IGNORADAS` (`groups: true`): número novo nasce ignorando grupos.

6. Métodos novos:

```ts
  /** Grupos em que o número está. O formato varia por engine: `id` string ou `{ _serialized }`. */
  async listarGrupos(session: string): Promise<Array<{ chatId: string; subject: string | null }>> {
    const res = await this.fetchComTeto(`${this.baseUrl}/api/${encodeURIComponent(session)}/groups`, {
      headers: { "X-Api-Key": this.apiKey },
    });
    if (!res.ok) throw new Error(`waha_groups_${res.status}`);
    const bruto = (await res.json().catch(() => null)) as unknown;
    const lista = Array.isArray(bruto) ? bruto : bruto && typeof bruto === "object" ? Object.values(bruto) : [];
    const grupos: Array<{ chatId: string; subject: string | null }> = [];
    for (const item of lista) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const id = o.id;
      const chatId =
        typeof id === "string" ? id
        : id && typeof id === "object" && typeof (id as Record<string, unknown>)._serialized === "string"
          ? ((id as Record<string, unknown>)._serialized as string)
          : typeof o.JID === "string" ? (o.JID as string) : null;
      if (!chatId || !chatId.endsWith("@g.us")) continue;
      const subject = typeof o.subject === "string" ? o.subject : typeof o.name === "string" ? o.name : null;
      grupos.push({ chatId, subject });
    }
    return grupos;
  }

  /**
   * Liga ou desliga o recebimento de grupos NESTA sessão. Só devolve `true` quando o GET
   * seguinte confirma a troca: o WAHA já respondeu 200 para operação que não aconteceu
   * (medido na issue melgarafael/DeskcommCRM#1428).
   */
  async definirRecebimentoDeGrupos(name: string, receber: boolean): Promise<boolean> {
    const url = `${this.baseUrl}/api/sessions/${encodeURIComponent(name)}`;
    const ler = async () => {
      const r = await this.fetchComTeto(url, { headers: { "X-Api-Key": this.apiKey } });
      if (!r.ok) return null;
      const p = sessionSnapshotSchema.safeParse(await r.json().catch(() => null));
      return p.success && p.data.name === name ? p.data : null;
    };
    const atual = await ler();
    if (!atual?.config) return false;
    const ignore = {
      ...((typeof atual.config.ignore === "object" && atual.config.ignore) || {}),
      ...CHAVES_DO_FILTRO_FIXAS,
      groups: !receber,
    };
    const put = await this.fetchComTeto(url, {
      method: "PUT",
      headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ name, config: { ...atual.config, ignore } }),
    });
    if (!put.ok) return false;
    // Se a Task 0 mediu que o NOWEB só aplica o filtro depois de reiniciar, chame aqui
    // `await this.startExistingSession(name)` antes de reler.
    const depois = await ler();
    const g = depois?.config && typeof depois.config.ignore === "object" && depois.config.ignore
      ? (depois.config.ignore as Record<string, unknown>).groups
      : undefined;
    return g === !receber;
  }
```

- [ ] **Step 4: Rodar os testes novos e os antigos do cliente**

Run: `pnpm exec vitest run lib/waha/client-grupos.test.ts lib/waha/client.test.ts`
Expected: PASS em todos. Se algum caso antigo de `client.test.ts` exigia que `groups:false` fosse incompatível (linha ~346, "filtro explícito incompatível"), **atualize esse caso**: ele media o comportamento que esta tarefa muda de propósito. Explique no commit.

- [ ] **Step 5: Sabotar**

Volte `compatibleSession` para `CONVERSAS_IGNORADAS`. Previsto: vermelho no caso "sessão com groups=false continua compatível". Restaure.

- [ ] **Step 6: Commit**

```bash
git add lib/waha/client.ts lib/waha/client-grupos.test.ts lib/waha/client.test.ts
git commit -m "feat(grupos): o filtro de grupos do WAHA passa a ser decidido pela funcionalidade de grupos"
```

---

### Task 4: Adapter de canal (a porta sem nome de provider)

**Files:**
- Modify: `lib/channels/types.ts` (interface `ChannelAdapter`)
- Modify: `lib/channels/adapters/waha.ts`
- Test: `lib/channels/adapters/waha-grupos.test.ts`

**Interfaces:**
- Consumes: `WahaClient.listarGrupos`, `WahaClient.definirRecebimentoDeGrupos` (Task 3).
- Produces: `interface ChannelGroup { chatId: string; subject: string | null }`; `ChannelAdapter.listGroups?(input: { sessionRef: string }): Promise<ChannelGroup[]>`; `ChannelAdapter.setGroupIntake?(input: { sessionRef: string; receive: boolean }): Promise<boolean>`.

- [ ] **Step 1: Teste**

```ts
// lib/channels/adapters/waha-grupos.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const listarGrupos = vi.fn();
const definirRecebimentoDeGrupos = vi.fn();
vi.mock("@/lib/waha/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/waha/client")>()),
  getWahaClient: () => ({ listarGrupos, definirRecebimentoDeGrupos }),
}));

import { wahaAdapter } from "./waha";

beforeEach(() => { listarGrupos.mockReset(); definirRecebimentoDeGrupos.mockReset(); });

describe("adapter: grupos", () => {
  it("lista grupos pela sessão", async () => {
    listarGrupos.mockResolvedValue([{ chatId: "1@g.us", subject: "A" }]);
    await expect(wahaAdapter.listGroups!({ sessionRef: "s1" })).resolves.toEqual([{ chatId: "1@g.us", subject: "A" }]);
    expect(listarGrupos).toHaveBeenCalledWith("s1");
  });
  it("repassa a pós-condição do liga/desliga", async () => {
    definirRecebimentoDeGrupos.mockResolvedValue(false);
    await expect(wahaAdapter.setGroupIntake!({ sessionRef: "s1", receive: true })).resolves.toBe(false);
    expect(definirRecebimentoDeGrupos).toHaveBeenCalledWith("s1", true);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run lib/channels/adapters/waha-grupos.test.ts`
Expected: FAIL (`listGroups` undefined).

- [ ] **Step 3: Implementar**

Em `lib/channels/types.ts`, perto de `ChannelAdapter`:

```ts
/** Um grupo em que o número está. Só canais com capacidade `groups` diferente de "none". */
export interface ChannelGroup {
  chatId: string;
  subject: string | null;
}
```

Dentro de `interface ChannelAdapter`:

```ts
  /** Grupos do número. Ausente = o canal não lista grupos. */
  listGroups?(input: { sessionRef: string }): Promise<ChannelGroup[]>;
  /** Liga/desliga o recebimento de grupos na sessão; `true` só com a troca confirmada. */
  setGroupIntake?(input: { sessionRef: string; receive: boolean }): Promise<boolean>;
```

Em `lib/channels/adapters/waha.ts`, dentro de `wahaAdapter` (use o mesmo jeito de obter o cliente que os métodos vizinhos, como `resolveRegisteredPhone`):

```ts
  async listGroups(input: { sessionRef: string }) {
    const client = getWahaClient();
    if (!client) throw new Error("waha_not_configured");
    return client.listarGrupos(input.sessionRef);
  },
  async setGroupIntake(input: { sessionRef: string; receive: boolean }) {
    const client = getWahaClient();
    if (!client) return false;
    return client.definirRecebimentoDeGrupos(input.sessionRef, input.receive);
  },
```

- [ ] **Step 4: Rodar teste e cerca de canal**

Run: `pnpm exec vitest run lib/channels/adapters/waha-grupos.test.ts && pnpm lint:channels`
Expected: PASS; `lint-channels: ok`.

- [ ] **Step 5: Commit**

```bash
git add lib/channels/types.ts lib/channels/adapters/waha.ts lib/channels/adapters/waha-grupos.test.ts
git commit -m "feat(grupos): listar grupos e ligar recebimento pela porta do adapter de canal"
```

---

### Task 5: Serviço de grupos (listar, ligar, desligar)

**Files:**
- Create: `lib/grupos/servico.ts`
- Test: `lib/grupos/servico.test.ts`

**Interfaces:**
- Consumes: `ChannelAdapter.listGroups`, `ChannelAdapter.setGroupIntake` (Task 4).
- Produces:
  - `interface GrupoDoNumero { chatId: string; subject: string | null; enabled: boolean; enabledAt: string | null }`
  - `interface DepsDeGrupos { db: GruposDb; listGroups(provider: ChannelProvider, sessionRef: string): Promise<ChannelGroup[]>; setGroupIntake(provider: ChannelProvider, sessionRef: string, receive: boolean): Promise<boolean>; audit(entry: { action: string; organizationId: string; actorUserId: string; resourceId: string; requestId: string; metadata: Record<string, unknown> }): Promise<void>; agora(): Date }`
  - `interface GruposDb { lerSessao(org: string, sessionId: string): Promise<{ provider: ChannelProvider; sessionRef: string; groupsCapability: "full" | "limited" | "none" } | null>; listarLinhas(org: string, sessionId: string): Promise<Array<{ group_chat_id: string; subject: string | null; enabled: boolean; enabled_at: string | null }>>; contarLigados(org: string, sessionId: string): Promise<number>; gravarLinha(org: string, sessionId: string, row: { group_chat_id: string; subject: string | null; enabled: boolean; enabled_at: string | null; enabled_by_user_id: string | null }): Promise<{ id: string }> }`
  - `listarGruposDoNumero(deps, { organizationId, channelSessionId }): Promise<GrupoDoNumero[]>`
  - `alternarGrupo(deps, { organizationId, channelSessionId, groupChatId, subject, ligar, actorUserId, requestId }): Promise<{ enabled: boolean }>`
  - `class GrupoError extends Error { code: "sessao_nao_encontrada" | "canal_sem_grupos" | "filtro_nao_confirmado" }`
  - `criarDepsDeGrupos(admin: SupabaseClient): DepsDeGrupos` (implementação real, com `organization_id` em toda consulta)

- [ ] **Step 1: Teste com fakes**

```ts
// lib/grupos/servico.test.ts
import { describe, expect, it, vi } from "vitest";
import { CHANNEL_PROVIDER_WAHA } from "@/lib/channels/capabilities";
import { alternarGrupo, GrupoError, listarGruposDoNumero, type DepsDeGrupos } from "./servico";

const ORG = "11111111-1111-4111-8111-111111111111";
const SESS = "22222222-2222-4222-8222-222222222222";
const G1 = "1@g.us"; const G2 = "2@g.us";

function deps(opts: { ligados?: string[]; capability?: "full" | "none"; confirma?: boolean } = {}) {
  const linhas = new Map<string, { group_chat_id: string; subject: string | null; enabled: boolean; enabled_at: string | null }>();
  for (const g of opts.ligados ?? []) linhas.set(g, { group_chat_id: g, subject: null, enabled: true, enabled_at: "2026-09-23T00:00:00.000Z" });
  const d: DepsDeGrupos & { setGroupIntake: ReturnType<typeof vi.fn>; audit: ReturnType<typeof vi.fn> } = {
    db: {
      lerSessao: vi.fn(async () => ({ provider: CHANNEL_PROVIDER_WAHA, sessionRef: "s1", groupsCapability: opts.capability ?? "full" })),
      listarLinhas: vi.fn(async () => [...linhas.values()]),
      contarLigados: vi.fn(async () => [...linhas.values()].filter((l) => l.enabled).length),
      gravarLinha: vi.fn(async (_o, _s, row) => { linhas.set(row.group_chat_id, row); return { id: "row-" + row.group_chat_id }; }),
    },
    listGroups: vi.fn(async () => [{ chatId: G1, subject: "Cliente A" }, { chatId: G2, subject: "Família" }]),
    setGroupIntake: vi.fn(async () => opts.confirma ?? true),
    audit: vi.fn(async () => {}),
    agora: () => new Date("2026-09-23T12:00:00.000Z"),
  };
  return d;
}
const base = { organizationId: ORG, channelSessionId: SESS, subject: "Cliente A", actorUserId: "u1", requestId: "r1" };

describe("listarGruposDoNumero", () => {
  it("junta a lista do WhatsApp com o estado gravado; o padrão é desligado", async () => {
    const r = await listarGruposDoNumero(deps({ ligados: [G1] }), { organizationId: ORG, channelSessionId: SESS });
    expect(r).toEqual([
      { chatId: G1, subject: "Cliente A", enabled: true, enabledAt: "2026-09-23T00:00:00.000Z" },
      { chatId: G2, subject: "Família", enabled: false, enabledAt: null },
    ]);
  });
  it("canal sem capacidade de grupos é recusado", async () => {
    await expect(listarGruposDoNumero(deps({ capability: "none" }), { organizationId: ORG, channelSessionId: SESS }))
      .rejects.toMatchObject({ code: "canal_sem_grupos" });
  });
});

describe("alternarGrupo", () => {
  it("ligar o PRIMEIRO grupo liga o recebimento no WhatsApp, grava e audita", async () => {
    const d = deps();
    await expect(alternarGrupo(d, { ...base, groupChatId: G1, ligar: true })).resolves.toEqual({ enabled: true });
    expect(d.setGroupIntake).toHaveBeenCalledWith(expect.anything(), "s1", true);
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "channel.group_enabled", organizationId: ORG, actorUserId: "u1" }));
  });
  it("ligar um SEGUNDO grupo não mexe no filtro", async () => {
    const d = deps({ ligados: [G2] });
    await alternarGrupo(d, { ...base, groupChatId: G1, ligar: true });
    expect(d.setGroupIntake).not.toHaveBeenCalled();
  });
  it("desligar o ÚLTIMO grupo volta a ignorar grupos", async () => {
    const d = deps({ ligados: [G1] });
    await expect(alternarGrupo(d, { ...base, groupChatId: G1, ligar: false })).resolves.toEqual({ enabled: false });
    expect(d.setGroupIntake).toHaveBeenCalledWith(expect.anything(), "s1", false);
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "channel.group_disabled" }));
  });
  it("sem confirmação do WhatsApp, o grupo NÃO fica ligado e nada é gravado", async () => {
    const d = deps({ confirma: false });
    await expect(alternarGrupo(d, { ...base, groupChatId: G1, ligar: true })).rejects.toBeInstanceOf(GrupoError);
    expect(d.db.gravarLinha).not.toHaveBeenCalled();
    expect(d.audit).not.toHaveBeenCalled();
  });
  it("id que não é de grupo é recusado antes de qualquer efeito", async () => {
    const d = deps();
    await expect(alternarGrupo(d, { ...base, groupChatId: "5521999990000@c.us", ligar: true })).rejects.toThrow();
    expect(d.setGroupIntake).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run lib/grupos/servico.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar**

```ts
// lib/grupos/servico.ts
/**
 * Grupos de WhatsApp na inbox: qual grupo de cada número entra no CRM.
 * Spec: docs/superpowers/specs/2026-09-23-grupos-na-inbox-design.md
 *
 * O filtro do WhatsApp é tudo ou nada por número: ligar o PRIMEIRO grupo passa a receber
 * todos (e a entrada descarta os não escolhidos); desligar o ÚLTIMO volta a ignorar. A troca
 * do filtro precisa ser CONFIRMADA antes de gravar "ligado": nunca fica ligado sem estar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { audit as auditReal } from "@/lib/audit";
import { capabilitiesOf } from "@/lib/channels/capabilities";
import { getAdapter } from "@/lib/channels";
import { resolveSessionRef, CHANNEL_SESSION_REF_COLUMNS, type ChannelSessionRef } from "@/lib/channels/session-ref";
import type { ChannelGroup, ChannelProvider } from "@/lib/channels/types";

export class GrupoError extends Error {
  constructor(public readonly code: "sessao_nao_encontrada" | "canal_sem_grupos" | "filtro_nao_confirmado") {
    super(code);
    this.name = "GrupoError";
  }
}

const chatIdDeGrupo = z.string().regex(/^[\d-]+@g\.us$/);

export interface GrupoDoNumero { chatId: string; subject: string | null; enabled: boolean; enabledAt: string | null }

interface LinhaDeGrupo { group_chat_id: string; subject: string | null; enabled: boolean; enabled_at: string | null }

export interface GruposDb {
  lerSessao(org: string, sessionId: string): Promise<{ provider: ChannelProvider; sessionRef: string; groupsCapability: "full" | "limited" | "none" } | null>;
  listarLinhas(org: string, sessionId: string): Promise<LinhaDeGrupo[]>;
  contarLigados(org: string, sessionId: string): Promise<number>;
  gravarLinha(org: string, sessionId: string, row: LinhaDeGrupo & { enabled_by_user_id: string | null }): Promise<{ id: string }>;
}

export interface DepsDeGrupos {
  db: GruposDb;
  listGroups(provider: ChannelProvider, sessionRef: string): Promise<ChannelGroup[]>;
  setGroupIntake(provider: ChannelProvider, sessionRef: string, receive: boolean): Promise<boolean>;
  audit(entry: { action: string; organizationId: string; actorUserId: string; resourceId: string; requestId: string; metadata: Record<string, unknown> }): Promise<void>;
  agora(): Date;
}

async function sessaoComGrupos(deps: DepsDeGrupos, org: string, sessionId: string) {
  const s = await deps.db.lerSessao(org, sessionId);
  if (!s) throw new GrupoError("sessao_nao_encontrada");
  if (s.groupsCapability === "none") throw new GrupoError("canal_sem_grupos");
  return s;
}

export async function listarGruposDoNumero(
  deps: DepsDeGrupos,
  e: { organizationId: string; channelSessionId: string },
): Promise<GrupoDoNumero[]> {
  const s = await sessaoComGrupos(deps, e.organizationId, e.channelSessionId);
  const [doCanal, gravados] = await Promise.all([deps.listGroups(s.provider, s.sessionRef), deps.db.listarLinhas(e.organizationId, e.channelSessionId)]);
  const porId = new Map(gravados.map((l) => [l.group_chat_id, l]));
  return doCanal.map((g) => {
    const l = porId.get(g.chatId);
    return { chatId: g.chatId, subject: g.subject ?? l?.subject ?? null, enabled: l?.enabled ?? false, enabledAt: l?.enabled_at ?? null };
  });
}

export async function alternarGrupo(
  deps: DepsDeGrupos,
  e: { organizationId: string; channelSessionId: string; groupChatId: string; subject: string | null; ligar: boolean; actorUserId: string; requestId: string },
): Promise<{ enabled: boolean }> {
  chatIdDeGrupo.parse(e.groupChatId);
  const s = await sessaoComGrupos(deps, e.organizationId, e.channelSessionId);
  const ligados = await deps.db.contarLigados(e.organizationId, e.channelSessionId);
  const precisaTrocarFiltro = e.ligar ? ligados === 0 : ligados === 1;
  if (precisaTrocarFiltro) {
    const confirmou = await deps.setGroupIntake(s.provider, s.sessionRef, e.ligar);
    if (!confirmou) throw new GrupoError("filtro_nao_confirmado");
  }
  const agora = deps.agora().toISOString();
  const row = await deps.db.gravarLinha(e.organizationId, e.channelSessionId, {
    group_chat_id: e.groupChatId,
    subject: e.subject,
    enabled: e.ligar,
    enabled_at: e.ligar ? agora : null,
    enabled_by_user_id: e.ligar ? e.actorUserId : null,
  });
  await deps.audit({
    action: e.ligar ? "channel.group_enabled" : "channel.group_disabled",
    organizationId: e.organizationId,
    actorUserId: e.actorUserId,
    resourceId: row.id,
    requestId: e.requestId,
    metadata: { channel_session_id: e.channelSessionId, group_chat_id: e.groupChatId, filtro_trocado: precisaTrocarFiltro },
  });
  return { enabled: e.ligar };
}

/** Dependências reais. `admin` é service role: TODA consulta filtra `organization_id`. */
export function criarDepsDeGrupos(admin: SupabaseClient): DepsDeGrupos {
  return {
    db: {
      async lerSessao(org, sessionId) {
        const { data } = await admin
          .from("channel_sessions")
          .select(`id, ${CHANNEL_SESSION_REF_COLUMNS}`)
          .eq("organization_id", org)
          .eq("id", sessionId)
          .maybeSingle();
        if (!data) return null;
        const ref = data as unknown as ChannelSessionRef & { provider: ChannelProvider };
        return { provider: ref.provider, sessionRef: resolveSessionRef(ref), groupsCapability: capabilitiesOf(ref.provider).groups };
      },
      async listarLinhas(org, sessionId) {
        const { data } = await admin
          .from("channel_session_groups")
          .select("group_chat_id, subject, enabled, enabled_at")
          .eq("organization_id", org)
          .eq("channel_session_id", sessionId);
        return (data ?? []) as LinhaDeGrupo[];
      },
      async contarLigados(org, sessionId) {
        const { count } = await admin
          .from("channel_session_groups")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", org)
          .eq("channel_session_id", sessionId)
          .eq("enabled", true);
        return count ?? 0;
      },
      async gravarLinha(org, sessionId, row) {
        const { data, error } = await admin
          .from("channel_session_groups")
          .upsert({ organization_id: org, channel_session_id: sessionId, ...row }, { onConflict: "organization_id,channel_session_id,group_chat_id" })
          .select("id")
          .single();
        if (error) throw error;
        return data as { id: string };
      },
    },
    async listGroups(provider, sessionRef) {
      const adapter = getAdapter(provider);
      if (!adapter.listGroups) throw new GrupoError("canal_sem_grupos");
      return adapter.listGroups({ sessionRef });
    },
    async setGroupIntake(provider, sessionRef, receive) {
      const adapter = getAdapter(provider);
      return adapter.setGroupIntake ? adapter.setGroupIntake({ sessionRef, receive }) : false;
    },
    async audit(entry) {
      await auditReal({
        action: entry.action,
        organizationId: entry.organizationId,
        resourceType: "channel_session_group",
        resourceId: entry.resourceId,
        requestId: entry.requestId,
        metadata: { ...entry.metadata, actor_user_id: entry.actorUserId },
      } as Parameters<typeof auditReal>[0]);
    },
    agora: () => new Date(),
  };
}
```

O provider vem da **própria sessão** (`lerSessao`), e o adapter é resolvido por ele, sem nomear provider fora de `lib/channels/`. Se `getAdapter` tiver outro nome em `lib/channels/index.ts`, use o nome real.

Confira também a forma de `audit()` em `lib/audit/index.ts` (o campo do ator pode ser `actor`/`actorUserId`) e o nome das ações em `lib/audit/actions.ts`. Se houver lista fechada de ações, acrescente `channel.group_enabled` e `channel.group_disabled`.

- [ ] **Step 4: Rodar teste e cercas**

Run: `pnpm exec vitest run lib/grupos/servico.test.ts tests/unit/admin-client-filtra-organizacao.test.ts && pnpm lint:channels`
Expected: PASS; nenhuma consulta nova sem filtro; `lint-channels: ok`.

- [ ] **Step 5: Sabotar**

Troque `ligados === 0` por `true`. Previsto: vermelho em "ligar um SEGUNDO grupo não mexe no filtro". Restaure.

- [ ] **Step 6: Commit**

```bash
git add lib/grupos/servico.ts lib/grupos/servico.test.ts lib/audit/actions.ts
git commit -m "feat(grupos): serviço que lista e liga/desliga grupos com a troca do filtro confirmada"
```

---

### Task 6: Rota `GET/PUT /api/v1/channel-sessions/[id]/groups`

**Files:**
- Create: `app/api/v1/channel-sessions/[id]/groups/route.ts`
- Create: `lib/auth/public-paths.ts` só se o padrão exigir (não exige: a rota é de sessão, com cookie)
- Test: `app/api/v1/channel-sessions/[id]/groups/route.test.ts`

**Interfaces:**
- Consumes: `listarGruposDoNumero`, `alternarGrupo`, `GrupoError`, `criarDepsDeGrupos` (Task 5).
- Produces: `GET → 200 { data: GrupoDoNumero[] }`; `PUT body { group_chat_id: string, subject?: string|null, enabled: boolean } → 200 { data: { enabled } }`; erros `403 forbidden` (papel < manager), `404 not_found` (sessão), `409 canal_sem_grupos`, `502 filtro_nao_confirmado`.

- [ ] **Step 1: Teste**

```ts
// app/api/v1/channel-sessions/[id]/groups/route.test.ts
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/grupos/servico", async (orig) => ({
  ...(await orig<typeof import("@/lib/grupos/servico")>()),
  criarDepsDeGrupos: vi.fn(() => ({})),
  listarGruposDoNumero: vi.fn(),
  alternarGrupo: vi.fn(),
}));

import { requireRole } from "@/lib/auth/require-role";
import { alternarGrupo, GrupoError, listarGruposDoNumero } from "@/lib/grupos/servico";
import { GET, PUT } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const SESS = "22222222-2222-4222-8222-222222222222";
const ctx = { params: Promise.resolve({ id: SESS }) };
const autorizado = () =>
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: "u1" }, org: { orgId: ORG, role: "manager" } } as never);

beforeEach(() => vi.clearAllMocks());

describe("grupos do número", () => {
  it("atendente não liga grupo (a rota exige gerente)", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) } as never);
    const res = await PUT(new NextRequest("http://x", { method: "PUT", body: JSON.stringify({ group_chat_id: "1@g.us", enabled: true }) }), ctx);
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.anything());
    expect(alternarGrupo).not.toHaveBeenCalled();
  });
  it("lista os grupos com a organização da sessão, nunca do body", async () => {
    autorizado();
    vi.mocked(listarGruposDoNumero).mockResolvedValue([{ chatId: "1@g.us", subject: "A", enabled: false, enabledAt: null }]);
    const res = await GET(new NextRequest("http://x"), ctx);
    expect(res.status).toBe(200);
    expect(listarGruposDoNumero).toHaveBeenCalledWith(expect.anything(), { organizationId: ORG, channelSessionId: SESS });
  });
  it("liga um grupo", async () => {
    autorizado();
    vi.mocked(alternarGrupo).mockResolvedValue({ enabled: true });
    const res = await PUT(new NextRequest("http://x", { method: "PUT", body: JSON.stringify({ group_chat_id: "1@g.us", subject: "A", enabled: true, organization_id: "outra" }) }), ctx);
    expect(res.status).toBe(200);
    expect(alternarGrupo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ organizationId: ORG, groupChatId: "1@g.us", ligar: true, actorUserId: "u1" }));
  });
  it("filtro não confirmado vira 502 e o grupo não fica ligado", async () => {
    autorizado();
    vi.mocked(alternarGrupo).mockRejectedValue(new GrupoError("filtro_nao_confirmado"));
    const res = await PUT(new NextRequest("http://x", { method: "PUT", body: JSON.stringify({ group_chat_id: "1@g.us", enabled: true }) }), ctx);
    expect(res.status).toBe(502);
  });
  it("body inválido é 400", async () => {
    autorizado();
    const res = await PUT(new NextRequest("http://x", { method: "PUT", body: JSON.stringify({ group_chat_id: "5568@c.us", enabled: "sim" }) }), ctx);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run "app/api/v1/channel-sessions/[id]/groups/route.test.ts"`
Expected: FAIL (rota não existe).

- [ ] **Step 3: Implementar** (copie o uso de `requireRole`, `requireSupportWrite` e `fail/ok` de `app/api/v1/channel-sessions/[id]/route.ts`; o retorno exato de `requireRole` está em `lib/auth/require-role.ts`)

```ts
// app/api/v1/channel-sessions/[id]/groups/route.ts
/**
 * GET/PUT /api/v1/channel-sessions/[id]/groups — os grupos do número e a chave de cada um.
 * Só gerente ou administrador. A organização vem da sessão autenticada, nunca do body.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { alternarGrupo, criarDepsDeGrupos, GrupoError, listarGruposDoNumero } from "@/lib/grupos/servico";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const corpoSchema = z.object({
  group_chat_id: z.string().regex(/^[\d-]+@g\.us$/),
  subject: z.string().max(200).nullable().optional(),
  enabled: z.boolean(),
});

const STATUS: Record<GrupoError["code"], number> = {
  sessao_nao_encontrada: 404,
  canal_sem_grupos: 409,
  filtro_nao_confirmado: 502,
};

function falhaDeGrupo(err: unknown, requestId: string): Response {
  if (err instanceof GrupoError) return fail(err.code, err.code, STATUS[err.code], { requestId });
  throw err;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "channel_session_groups" });
  if (!authz.ok) return authz.response;
  const id = idSchema.safeParse((await ctx.params).id);
  if (!id.success) return fail("validation_error", "id inválido", 400, { requestId });
  try {
    const grupos = await listarGruposDoNumero(criarDepsDeGrupos(createAdminClient()), {
      organizationId: authz.org.orgId,
      channelSessionId: id.data,
    });
    return ok(grupos, { requestId });
  } catch (err) {
    return falhaDeGrupo(err, requestId);
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "channel_session_groups" });
  if (!authz.ok) return authz.response;
  const id = idSchema.safeParse((await ctx.params).id);
  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!id.success || !corpo.success) return fail("validation_error", "dados inválidos", 400, { requestId });
  try {
    const r = await alternarGrupo(criarDepsDeGrupos(createAdminClient()), {
      organizationId: authz.org.orgId,
      channelSessionId: id.data,
      groupChatId: corpo.data.group_chat_id,
      subject: corpo.data.subject ?? null,
      ligar: corpo.data.enabled,
      actorUserId: authz.user.id,
      requestId,
    });
    return ok(r, { requestId });
  } catch (err) {
    return falhaDeGrupo(err, requestId);
  }
}
```

Ajuste `authz.org.orgId` e `authz.user.id` aos nomes reais do retorno de `requireRole`. O teste usa os mesmos nomes; mude os dois juntos.

- [ ] **Step 4: Rodar teste, cercas de rota e de navegação**

Run: `pnpm exec vitest run "app/api/v1/channel-sessions/[id]/groups/route.test.ts" tests/unit/admin-client-filtra-organizacao.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "app/api/v1/channel-sessions/[id]/groups"
git commit -m "feat(grupos): rota para listar e ligar/desligar grupos do número (gerente+)"
```

---

### Task 7: Entrada de mensagem de grupo

**Files:**
- Create: `lib/grupos/ingest.ts`
- Modify: `lib/waha/ingest.ts` (`handleInbound` linha ~597 e `handleOutboundFromUserPhone` linha ~817: o `return` de grupo vira desvio)
- Test: `lib/grupos/ingest.test.ts`

**Interfaces:**
- Consumes: `remetenteDeGrupoSchema` (Task 2); tabela e colunas da Task 1.
- Produces: `gravarMensagemDeGrupo(db: IngestDeGrupoDb, e: EntradaDeGrupo): Promise<"gravada" | "grupo_desligado" | "duplicada" | "vazia">`, onde
  - `interface EntradaDeGrupo { organizationId: string; channelSessionId: string; groupChatId: string; direction: "inbound" | "outbound"; externalId: string; type: string; body: string | null; mediaUrl: string | null; mediaMime: string | null; sentAt: string; remetente: RemetenteDeGrupo | null; rawType: string | null }`
  - `interface IngestDeGrupoDb { grupoLigado(org, session, chatId): Promise<{ id: string; subject: string | null; contactId: string | null; conversationId: string | null } | null>; criarContatoDoGrupo(org, chatId, subject): Promise<string>; criarConversaDoGrupo(org, session, contactId, chatId): Promise<string>; vincular(org, grupoId, contactId, conversationId): Promise<void>; inserirMensagem(row: Record<string, unknown>): Promise<"ok" | "duplicada">; marcarConversa(org, conversationId, preview: string | null, quando: string): Promise<void> }`
  - `criarIngestDeGrupoDb(admin: SupabaseClient): IngestDeGrupoDb`

- [ ] **Step 1: Teste**

```ts
// lib/grupos/ingest.test.ts
import { describe, expect, it, vi } from "vitest";
import { gravarMensagemDeGrupo, type EntradaDeGrupo, type IngestDeGrupoDb } from "./ingest";

const ORG = "11111111-1111-4111-8111-111111111111";
const SESS = "22222222-2222-4222-8222-222222222222";
const entrada = (o: Partial<EntradaDeGrupo> = {}): EntradaDeGrupo => ({
  organizationId: ORG, channelSessionId: SESS, groupChatId: "1@g.us", direction: "inbound",
  externalId: "ext-1", type: "text", body: "oi", mediaUrl: null, mediaMime: null,
  sentAt: "2026-09-23T12:00:00.000Z", remetente: { name: "Maria", phone: "+5521999990000", lid: null }, rawType: "chat", ...o,
});
function db(grupo: Awaited<ReturnType<IngestDeGrupoDb["grupoLigado"]>>, dup = false) {
  return {
    grupoLigado: vi.fn(async () => grupo),
    criarContatoDoGrupo: vi.fn(async () => "contato-g"),
    criarConversaDoGrupo: vi.fn(async () => "conversa-g"),
    vincular: vi.fn(async () => {}),
    inserirMensagem: vi.fn(async () => (dup ? "duplicada" : "ok") as "ok" | "duplicada"),
    marcarConversa: vi.fn(async () => {}),
  } satisfies IngestDeGrupoDb;
}

describe("gravarMensagemDeGrupo", () => {
  it("grupo desligado: descarta sem gravar nada", async () => {
    const d = db(null);
    await expect(gravarMensagemDeGrupo(d, entrada())).resolves.toBe("grupo_desligado");
    expect(d.inserirMensagem).not.toHaveBeenCalled();
    expect(d.criarContatoDoGrupo).not.toHaveBeenCalled();
  });
  it("primeira mensagem de um grupo ligado cria contato e conversa do grupo e grava com o remetente", async () => {
    const d = db({ id: "g1", subject: "Cliente A", contactId: null, conversationId: null });
    await expect(gravarMensagemDeGrupo(d, entrada())).resolves.toBe("gravada");
    expect(d.criarContatoDoGrupo).toHaveBeenCalledWith(ORG, "1@g.us", "Cliente A");
    expect(d.criarConversaDoGrupo).toHaveBeenCalledWith(ORG, SESS, "contato-g", "1@g.us");
    expect(d.vincular).toHaveBeenCalledWith(ORG, "g1", "contato-g", "conversa-g");
    const row = d.inserirMensagem.mock.calls[0]![0];
    expect(row).toMatchObject({
      organization_id: ORG, conversation_id: "conversa-g", contact_id: "contato-g", direction: "inbound", external_id: "ext-1",
      metadata: { raw_type: "chat", group_sender: { name: "Maria", phone: "+5521999990000", lid: null } },
    });
  });
  it("grupo já vinculado reaproveita contato e conversa", async () => {
    const d = db({ id: "g1", subject: "A", contactId: "c", conversationId: "v" });
    await gravarMensagemDeGrupo(d, entrada());
    expect(d.criarContatoDoGrupo).not.toHaveBeenCalled();
    expect(d.inserirMensagem.mock.calls[0]![0]).toMatchObject({ conversation_id: "v", contact_id: "c" });
  });
  it("mensagem repetida (mesmo external_id) não duplica", async () => {
    const d = db({ id: "g1", subject: "A", contactId: "c", conversationId: "v" }, true);
    await expect(gravarMensagemDeGrupo(d, entrada())).resolves.toBe("duplicada");
    expect(d.marcarConversa).not.toHaveBeenCalled();
  });
  it("mensagem enviada do celular entra como outbound, sem remetente", async () => {
    const d = db({ id: "g1", subject: "A", contactId: "c", conversationId: "v" });
    await gravarMensagemDeGrupo(d, entrada({ direction: "outbound", remetente: null }));
    expect(d.inserirMensagem.mock.calls[0]![0]).toMatchObject({ direction: "outbound", sent_via: "external_device" });
    expect((d.inserirMensagem.mock.calls[0]![0].metadata as Record<string, unknown>).group_sender).toBeUndefined();
  });
  it("mensagem sem texto e sem mídia é ignorada", async () => {
    const d = db({ id: "g1", subject: "A", contactId: "c", conversationId: "v" });
    await expect(gravarMensagemDeGrupo(d, entrada({ body: null }))).resolves.toBe("vazia");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run lib/grupos/ingest.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar `lib/grupos/ingest.ts`**

```ts
// lib/grupos/ingest.ts
/**
 * Mensagem de um grupo LIGADO entra na inbox. Grupo desligado é descartado, como sempre foi.
 *
 * O que esta entrada NÃO faz, de propósito: `aplicarEfeitosPosEntrada` (opt-out, lead,
 * atribuição), `acelerarPipelineDeEventos` e o audit `message.received`. O banco emite
 * `message.group_received` para conversa de grupo (migration grupos_na_inbox), e nenhum
 * consumidor de `message.received` — IA, follow-up, campanhas, automações — a vê.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { remetenteDeGrupoSchema, type RemetenteDeGrupo } from "@/lib/messaging/remetente-de-grupo";

export interface EntradaDeGrupo {
  organizationId: string; channelSessionId: string; groupChatId: string;
  direction: "inbound" | "outbound"; externalId: string; type: string;
  body: string | null; mediaUrl: string | null; mediaMime: string | null;
  sentAt: string; remetente: RemetenteDeGrupo | null; rawType: string | null;
}

export interface IngestDeGrupoDb {
  grupoLigado(org: string, session: string, chatId: string): Promise<{ id: string; subject: string | null; contactId: string | null; conversationId: string | null } | null>;
  criarContatoDoGrupo(org: string, chatId: string, subject: string | null): Promise<string>;
  criarConversaDoGrupo(org: string, session: string, contactId: string, chatId: string): Promise<string>;
  vincular(org: string, grupoId: string, contactId: string, conversationId: string): Promise<void>;
  inserirMensagem(row: Record<string, unknown>): Promise<"ok" | "duplicada">;
  marcarConversa(org: string, conversationId: string, preview: string | null, quando: string): Promise<void>;
}

export async function gravarMensagemDeGrupo(
  db: IngestDeGrupoDb,
  e: EntradaDeGrupo,
): Promise<"gravada" | "grupo_desligado" | "duplicada" | "vazia"> {
  if (!e.body && !e.mediaUrl) return "vazia";
  const grupo = await db.grupoLigado(e.organizationId, e.channelSessionId, e.groupChatId);
  if (!grupo) return "grupo_desligado";

  let contactId = grupo.contactId;
  let conversationId = grupo.conversationId;
  if (!contactId || !conversationId) {
    contactId ??= await db.criarContatoDoGrupo(e.organizationId, e.groupChatId, grupo.subject);
    conversationId ??= await db.criarConversaDoGrupo(e.organizationId, e.channelSessionId, contactId, e.groupChatId);
    await db.vincular(e.organizationId, grupo.id, contactId, conversationId);
  }

  const remetente = e.direction === "inbound" && e.remetente ? remetenteDeGrupoSchema.safeParse(e.remetente) : null;
  const agora = new Date().toISOString();
  const resultado = await db.inserirMensagem({
    organization_id: e.organizationId,
    conversation_id: conversationId,
    channel_session_id: e.channelSessionId,
    contact_id: contactId,
    external_id: e.externalId,
    type: e.type,
    direction: e.direction,
    status: e.direction === "inbound" ? "delivered" : "sent",
    body: e.body,
    media_url: e.mediaUrl,
    media_mime: e.mediaMime,
    sent_via: "external_device",
    sent_at: e.sentAt,
    delivered_at: e.direction === "inbound" ? agora : null,
    metadata: {
      raw_type: e.rawType,
      ...(remetente?.success ? { group_sender: remetente.data } : {}),
    },
  });
  if (resultado === "duplicada") return "duplicada";
  await db.marcarConversa(e.organizationId, conversationId, e.body ? e.body.slice(0, 140) : null, e.sentAt);
  return "gravada";
}

/** Implementação real. `admin` é service role: toda consulta filtra `organization_id`. */
export function criarIngestDeGrupoDb(admin: SupabaseClient): IngestDeGrupoDb {
  return {
    async grupoLigado(org, session, chatId) {
      const { data } = await admin
        .from("channel_session_groups")
        .select("id, subject, contact_id, conversation_id")
        .eq("organization_id", org)
        .eq("channel_session_id", session)
        .eq("group_chat_id", chatId)
        .eq("enabled", true)
        .maybeSingle();
      const r = data as { id: string; subject: string | null; contact_id: string | null; conversation_id: string | null } | null;
      return r ? { id: r.id, subject: r.subject, contactId: r.contact_id, conversationId: r.conversation_id } : null;
    },
    async criarContatoDoGrupo(org, chatId, subject) {
      const nome = subject ?? "Grupo de WhatsApp";
      const { data, error } = await admin
        .from("contacts")
        .insert({ organization_id: org, name: nome, display_name: nome, kind: "whatsapp_group", source: "whatsapp_group", source_metadata: { group_chat_id: chatId } })
        .select("id")
        .single();
      if (error) throw error;
      return (data as { id: string }).id;
    },
    async criarConversaDoGrupo(org, session, contactId, chatId) {
      const { data, error } = await admin
        .from("conversations")
        .insert({ organization_id: org, contact_id: contactId, channel_session_id: session, channel: "whatsapp", status: "open", is_group: true, group_chat_id: chatId })
        .select("id")
        .single();
      if (error) throw error;
      return (data as { id: string }).id;
    },
    async vincular(org, grupoId, contactId, conversationId) {
      const { error } = await admin
        .from("channel_session_groups")
        .update({ contact_id: contactId, conversation_id: conversationId })
        .eq("organization_id", org)
        .eq("id", grupoId);
      if (error) logger.warn("[grupos.ingest] vínculo do grupo não gravado", { organization_id: org, grupo_id: grupoId, causa: error.message });
    },
    async inserirMensagem(row) {
      const { error } = await admin.from("messages").insert(row);
      if (!error) return "ok";
      if (error.code === "23505") return "duplicada";
      throw error;
    },
    async marcarConversa(org, conversationId, preview, quando) {
      const { error } = await admin
        .from("conversations")
        .update({ last_message_at: quando, last_message_preview: preview })
        .eq("organization_id", org)
        .eq("id", conversationId);
      if (error) logger.warn("[grupos.ingest] conversa não carimbada", { organization_id: org, conversation_id: conversationId, causa: error.message });
    },
  };
}
```

Antes de fechar o passo, confira em `lib/channels/marcar-conversa.ts` como o carimbo é feito (nomes de coluna e RPC). Se existir `marcarConversaComMensagem(...)`, use-o em `marcarConversa` em vez do `update` à mão.

Duas corridas com dois webhooks simultâneos do mesmo grupo novo criariam dois contatos. Resolva com um `unique` parcial: acrescente à migration da Task 1, e ao teste de invariante, `create unique index if not exists uq_contacts_grupo on public.contacts (organization_id, (source_metadata->>'group_chat_id')) where kind = 'whatsapp_group';`. Em `criarContatoDoGrupo`, capture o `23505` e releia o contato existente pelo mesmo par.

- [ ] **Step 4: Ligar em `lib/waha/ingest.ts`**

Em `handleInbound`, troque `if (parsed.kind === "group") return; // grupos não fazem binding CRM` por:

```ts
  if (parsed.kind === "group") {
    // Grupo só entra se estiver LIGADO em Conexões › Grupos; o resto é descartado, como antes.
    // Nada de pós-entrada, lead, opt-out ou pipeline de IA: ver lib/grupos/ingest.ts.
    if (!p.id) return;
    const autor = p.author ?? p.participant ?? null;
    const autorParsed = autor ? parseChatId(autor) : null;
    await gravarMensagemDeGrupo(criarIngestDeGrupoDb(admin), {
      organizationId: session.organization_id,
      channelSessionId: session.id,
      groupChatId: chatId,
      direction: "inbound",
      externalId: p.id,
      type: resolveMessageType(p),
      body: bodyOf(p),
      mediaUrl: mediaUrlOf(p),
      mediaMime: mediaMimeOf(p),
      sentAt: dataDoTimestamp(p.timestamp, new Date().toISOString()),
      remetente: {
        name: notifyNameOf(p),
        phone: autorParsed?.kind === "phone" ? canonicalPhoneBR(autorParsed.phone) : null,
        lid: autorParsed?.kind === "lid" ? autorParsed.lid : null,
      },
      rawType: p.type ?? null,
    });
    return;
  }
```

Em `handleOutboundFromUserPhone`, o mesmo desvio com `direction: "outbound"` e `remetente: null`, **depois** do reconhecimento de eco (`ehEcoDeEnvioNosso`): a resposta que o atendente mandou pela inbox volta pelo webhook e não pode entrar de novo. Confira a ordem das guardas nessa função antes de inserir.

Se `p.author`/`p.participant` não existirem no tipo `WahaPayload`, acrescente-os como `string | null | undefined` (a doutrina: "Sender é `p.author`, não `p.from`"). Confirme o nome real do campo pela fixture da Task 0.

Imports no topo: `import { criarIngestDeGrupoDb, gravarMensagemDeGrupo } from "@/lib/grupos/ingest";`.

- [ ] **Step 5: Rodar testes do grupo e do ingest existente**

Run: `pnpm exec vitest run lib/grupos/ingest.test.ts lib/waha`
Expected: PASS. Testes antigos que afirmavam "grupo é descartado" continuam válidos para grupo **desligado**. Se algum afirmava "nenhuma escrita para `@g.us`" com um banco falso que não conhece `channel_session_groups`, ajuste o banco falso para responder "não ligado" e mantenha a afirmação.

- [ ] **Step 6: Sabotar**

Em `gravarMensagemDeGrupo`, troque `if (!grupo) return "grupo_desligado";` por `if (false) ...`. Previsto: vermelho em "grupo desligado: descarta sem gravar nada". Restaure.

- [ ] **Step 7: Commit**

```bash
git add lib/grupos/ingest.ts lib/grupos/ingest.test.ts lib/waha/ingest.ts lib/waha/types.ts supabase/migrations/*_grupos_na_inbox.sql supabase/baseline.sql tests/invariants/grupos-na-inbox.test.ts
git commit -m "feat(grupos): mensagem de grupo ligado entra na inbox com o remetente, sem pós-entrada"
```

---

### Task 8: Notificação do atendente e contatos fora das listas

**Files:**
- Modify: `lib/notifications/push.handler.ts:112`
- Modify: `app/api/v1/contacts/_handler.ts` (listagem, linha ~100)
- Modify: `lib/campanhas/consulta-de-audiencia.ts` (linhas ~66 e ~112)
- Test: `lib/notifications/push.handler.test.ts` (existente ou novo), `tests/unit/grupo-fora-de-listas.test.ts` (novo)

**Interfaces:**
- Consumes: evento `message.group_received` (Task 1); `contacts.kind` (Task 1).

- [ ] **Step 1: Teste de inscrição e de listas**

```ts
// tests/unit/grupo-fora-de-listas.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { webPushInboundHandler } from "@/lib/notifications/push.handler";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";

describe("grupos: quem escuta e quem não escuta", () => {
  it("a notificação do atendente escuta mensagem de grupo", () => {
    expect(webPushInboundHandler.events).toContain("message.group_received");
  });

  it("nenhum outro consumidor registrado escuta message.group_received", async () => {
    const { handlersParaTeste } = await import("@/lib/event-log/dispatcher");
    ensureHandlersRegistered();
    const escutam = handlersParaTeste()
      .filter((h) => h.events.includes("message.group_received"))
      .map((h) => h.key);
    expect(escutam).toEqual([webPushInboundHandler.key]);
  });

  it("listagem de contatos e audiência de campanha excluem o contato de grupo", () => {
    for (const arquivo of ["app/api/v1/contacts/_handler.ts", "lib/campanhas/consulta-de-audiencia.ts"]) {
      expect(readFileSync(arquivo, "utf8"), arquivo).toMatch(/\.eq\(\s*["']kind["']\s*,\s*["']person["']\s*\)/);
    }
  });
});
```

Se o `dispatcher` não expuser a lista de handlers registrados, acrescente nele `export function handlersParaTeste(): readonly EventHandler[]` (só leitura, sem efeito). É a peça que torna a trava possível: um consumidor futuro que escute o evento de grupo reprova aqui, com nome.

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run tests/unit/grupo-fora-de-listas.test.ts`
Expected: FAIL (o evento não está na lista do push; as consultas não filtram `kind`).

- [ ] **Step 3: Implementar**

- `lib/notifications/push.handler.ts:112`: `events: ["message.received", "message.group_received", "lead.assigned", "lead.won", "lead.lost", "user.mentioned"],`. Confira no corpo do handler se ele usa `event_type === "message.received"` para escolher o texto da notificação. Se usar, trate `message.group_received` no mesmo ramo, com o título "Nova mensagem no grupo".
- `app/api/v1/contacts/_handler.ts`: na consulta de listagem (a de `listContactsHandler`, linha ~100), acrescente `.eq("kind", "person")` logo depois de `.eq("organization_id", ctx.organization_id)`.
- `lib/campanhas/consulta-de-audiencia.ts`: nas duas consultas, `.eq("kind", "person")`.

Se `lib/database.types.ts` não tiver `kind` em `contacts` e o typecheck reclamar, regenere os tipos contra o banco local (`npx supabase gen types typescript --local > lib/database.types.ts`) e confira o diff: ele deve acrescentar só `kind` e `channel_session_groups`.

- [ ] **Step 4: Rodar**

Run: `pnpm exec vitest run tests/unit/grupo-fora-de-listas.test.ts lib/notifications app/api/v1/contacts lib/campanhas`
Expected: PASS.

- [ ] **Step 5: Sabotar**

Tire `"message.group_received"` do push. Previsto: 1 vermelho. Restaure.

- [ ] **Step 6: Commit**

```bash
git add lib/notifications/push.handler.ts lib/event-log/dispatcher.ts app/api/v1/contacts/_handler.ts lib/campanhas/consulta-de-audiencia.ts tests/unit/grupo-fora-de-listas.test.ts lib/database.types.ts
git commit -m "feat(grupos): atendente é notificado; contato de grupo fica fora de listas e campanhas"
```

---

### Task 9: Tela de ligar grupos (Conexões)

**Files:**
- Create: `components/connections/GruposSheet.tsx`
- Modify: `components/connections/ConnectionsClient.tsx` (botão ao lado de "Proteção de envio", linha ~436, e o sheet, linha ~462)
- Test: `components/connections/GruposSheet.test.tsx`

**Interfaces:**
- Consumes: `GET/PUT /api/v1/channel-sessions/[id]/groups` (Task 6).
- Produces: `GruposSheet({ channelId: string; onClose: () => void })`.

- [ ] **Step 1: Teste (React Testing Library, no padrão de `components/connections/PairingOptions.test.tsx`)**

```tsx
// components/connections/GruposSheet.test.tsx
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GruposSheet } from "./GruposSheet";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
const resposta = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status }));

describe("GruposSheet", () => {
  it("lista os grupos com o estado de cada um", async () => {
    fetchMock.mockReturnValueOnce(resposta([{ chatId: "1@g.us", subject: "Cliente A", enabled: true, enabledAt: "2026-09-23T00:00:00Z" }, { chatId: "2@g.us", subject: "Família", enabled: false, enabledAt: null }]));
    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    expect(await screen.findByText("Cliente A")).toBeInTheDocument();
    expect(screen.getByText("Família")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Cliente A/ })).toBeChecked();
    expect(screen.getByRole("switch", { name: /Família/ })).not.toBeChecked();
  });

  it("ao ligar o primeiro grupo, avisa sobre o volume antes de enviar", async () => {
    fetchMock.mockReturnValueOnce(resposta([{ chatId: "2@g.us", subject: "Família", enabled: false, enabledAt: null }]));
    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("switch", { name: /Família/ }));
    expect(await screen.findByText(/passa a enviar mensagens de todos os grupos/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falha do WhatsApp mantém a chave desligada e mostra o erro", async () => {
    fetchMock
      .mockReturnValueOnce(resposta([{ chatId: "1@g.us", subject: "A", enabled: false, enabledAt: null }, { chatId: "2@g.us", subject: "B", enabled: true, enabledAt: "x" }]))
      .mockReturnValueOnce(resposta({ code: "filtro_nao_confirmado", message: "x" }, 502));
    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    const chave = await screen.findByRole("switch", { name: /^A/ });
    fireEvent.click(chave);
    await waitFor(() => expect(screen.getByText(/não confirmou/i)).toBeInTheDocument());
    expect(chave).not.toBeChecked();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run components/connections/GruposSheet.test.tsx`
Expected: FAIL (componente não existe).

- [ ] **Step 3: Implementar** (copie `Sheet`, `Switch`, `Button` e `t()` do mesmo jeito que `AntiBanSheet.tsx` os importa)

```tsx
// components/connections/GruposSheet.tsx
"use client";
/**
 * Conexões › Grupos: quais grupos deste número aparecem na inbox. Só gerente+ abre isto
 * (a rota também exige). A IA nunca responde em grupo; o texto diz isso na tela.
 */
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/lib/i18n/use-t";

interface Grupo { chatId: string; subject: string | null; enabled: boolean; enabledAt: string | null }

const AVISO_DE_VOLUME =
  "A partir de agora, o WhatsApp deste número passa a enviar mensagens de todos os grupos para o sistema. Só os grupos ligados aparecem no chat; os outros são descartados.";

export function GruposSheet({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const t = useT();
  const [grupos, setGrupos] = useState<Grupo[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, setPendente] = useState<Grupo | null>(null);
  const [salvando, setSalvando] = useState<string | null>(null);

  async function carregar() {
    setErro(null);
    const res = await fetch(`/api/v1/channel-sessions/${channelId}/groups`);
    const j = (await res.json().catch(() => null)) as { data?: Grupo[] } | null;
    if (!res.ok || !j?.data) { setErro(t("Não consegui ler os grupos deste número.")); return; }
    setGrupos(j.data);
  }
  useEffect(() => { void carregar(); }, [channelId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function gravar(g: Grupo, enabled: boolean) {
    setSalvando(g.chatId); setErro(null);
    const res = await fetch(`/api/v1/channel-sessions/${channelId}/groups`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_chat_id: g.chatId, subject: g.subject, enabled }),
    });
    setSalvando(null);
    if (!res.ok) {
      setErro(res.status === 502 ? t("O WhatsApp não confirmou a mudança. Nada foi alterado; tente de novo.") : t("Não foi possível salvar."));
      return;
    }
    setGrupos((atual) => atual?.map((x) => (x.chatId === g.chatId ? { ...x, enabled } : x)) ?? null);
  }

  function alternar(g: Grupo, enabled: boolean) {
    const nenhumLigado = !(grupos ?? []).some((x) => x.enabled);
    if (enabled && nenhumLigado) { setPendente(g); return; }
    void gravar(g, enabled);
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{t("Grupos")}</SheetTitle>
          <SheetDescription>
            {t("Grupos ligados aparecem no chat para os atendentes responderem. A IA nunca responde em grupo.")}
          </SheetDescription>
        </SheetHeader>
        <Button variant="outline" size="sm" onClick={() => void carregar()}>{t("Atualizar lista")}</Button>
        {erro && <p role="alert" className="text-sm text-destructive">{erro}</p>}
        {pendente && (
          <div role="alertdialog" className="rounded-md border p-3 text-sm">
            <p>{t(AVISO_DE_VOLUME)}</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => { const g = pendente; setPendente(null); void gravar(g, true); }}>{t("Ligar mesmo assim")}</Button>
              <Button size="sm" variant="outline" onClick={() => setPendente(null)}>{t("Cancelar")}</Button>
            </div>
          </div>
        )}
        <ul className="mt-3 space-y-2">
          {(grupos ?? []).map((g) => (
            <li key={g.chatId} className="flex items-center justify-between gap-3">
              <span className="text-sm">{g.subject ?? t("Grupo sem nome")}</span>
              <Switch
                aria-label={`${g.subject ?? t("Grupo sem nome")}`}
                checked={g.enabled}
                disabled={salvando === g.chatId}
                onCheckedChange={(v) => alternar(g, v)}
              />
            </li>
          ))}
        </ul>
        {grupos?.length === 0 && <p className="text-sm text-muted-foreground">{t("Este número não está em nenhum grupo.")}</p>}
      </SheetContent>
    </Sheet>
  );
}
```

Confira os caminhos reais de `Sheet`, `Switch` e do hook de tradução em `AntiBanSheet.tsx` e use os mesmos. Se não houver `Switch` em `components/ui`, use o `Checkbox` que existir com `role="switch"`.

Em `ConnectionsClient.tsx`:

- estado `const [gruposId, setGruposId] = useState<string | null>(null);`
- ao lado do botão "Proteção de envio", o botão abaixo. Use o dado que o cliente já tem para papel e capacidade; se o cartão não tiver o papel do usuário, leia-o do mesmo lugar que decide `canWrite` do `AntiBanSheet`:

```tsx
{podeGerenciarGrupos(c) && (
  <Button variant="outline" size="sm" onClick={() => setGruposId(c.id)}>
    <UsersThree size={14} aria-hidden />
    {t("Grupos")}
  </Button>
)}
```

com `podeGerenciarGrupos = (c) => ehGerente && capabilitiesOf(c.provider).groups !== "none"`;
- e o sheet: `{gruposId !== null && <GruposSheet channelId={gruposId} onClose={() => setGruposId(null)} />}`.

- [ ] **Step 4: Rodar**

Run: `pnpm exec vitest run components/connections && pnpm lint:channels && pnpm exec eslint components/connections/GruposSheet.tsx components/connections/ConnectionsClient.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/connections/GruposSheet.tsx components/connections/GruposSheet.test.tsx components/connections/ConnectionsClient.tsx
git commit -m "feat(grupos): Conexões › Grupos liga e desliga cada grupo do número"
```

---

### Task 10: Grupo na inbox (etiqueta, remetente, filtro)

**Files:**
- Modify: `components/inbox/ConversationListItem.tsx`
- Modify: `components/inbox/MessageBubble.tsx`
- Modify: `components/inbox/InboxFilters.tsx` e o handler de listagem de conversas (`app/api/v1/conversations/_handler.ts`), se o filtro for do servidor
- Test: `components/inbox/MessageBubble.test.tsx` (existente), `components/inbox/ConversationListItem.test.tsx` (novo)

**Interfaces:**
- Consumes: `lerRemetenteDeGrupo`, `rotuloDoRemetente` (Task 2); `conversations.is_group`.

- [ ] **Step 1: Confirmar que `is_group` chega à inbox**

```bash
grep -nE "SELECT_COLS|is_group" app/api/v1/conversations/_handler.ts | head -5
grep -nE "is_group" lib/types/messaging.ts
```

Se `SELECT_COLS` não tiver `is_group`, acrescente-o, e acrescente `is_group: boolean` ao tipo `Conversation` em `lib/types/messaging.ts`.

- [ ] **Step 2: Testes**

Em `components/inbox/MessageBubble.test.tsx`, um caso novo (copie o `render` e as props mínimas dos casos existentes do arquivo):

```tsx
it("mensagem de grupo mostra quem mandou acima do balão", () => {
  renderBubble({ direction: "inbound", body: "bom dia", metadata: { group_sender: { name: "Maria", phone: "+5521999990000", lid: null } } });
  expect(screen.getByText("Maria · +5521999990000")).toBeInTheDocument();
});
it("mensagem individual não mostra remetente", () => {
  renderBubble({ direction: "inbound", body: "bom dia", metadata: {} });
  expect(screen.queryByText(/·/)).toBeNull();
});
```

`components/inbox/ConversationListItem.test.tsx` (novo; copie as props mínimas de onde `ConversationListItem` é usado em `ConversationList.tsx`):

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConversationListItem } from "./ConversationListItem";
import { conversaDeExemplo } from "./__fixtures__/conversa";

describe("ConversationListItem", () => {
  it("conversa de grupo tem a etiqueta Grupo", () => {
    render(<ConversationListItem conversation={{ ...conversaDeExemplo, is_group: true }} {...conversaDeExemplo.props} />);
    expect(screen.getByText("Grupo")).toBeInTheDocument();
  });
  it("conversa individual não tem", () => {
    render(<ConversationListItem conversation={{ ...conversaDeExemplo, is_group: false }} {...conversaDeExemplo.props} />);
    expect(screen.queryByText("Grupo")).toBeNull();
  });
});
```

Crie `components/inbox/__fixtures__/conversa.ts` com uma conversa mínima válida (as props exigidas pelo componente) e reuse-a. Não invente campos: leia o tipo de props do componente.

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm exec vitest run components/inbox/MessageBubble.test.tsx components/inbox/ConversationListItem.test.tsx`
Expected: FAIL nos casos novos.

- [ ] **Step 4: Implementar**

- `MessageBubble.tsx`: `const remetente = message.direction === "inbound" ? lerRemetenteDeGrupo(message.metadata) : null;` e, acima do conteúdo do balão, `{remetente && <p className="mb-0.5 text-[11px] font-medium text-muted-foreground">{rotuloDoRemetente(remetente)}</p>}`.
- `ConversationListItem.tsx`: ao lado do nome, `{conversation.is_group && <Badge variant="secondary">{t("Grupo")}</Badge>}` (use o `Badge` que o arquivo já importa ou o de `components/ui/badge`).
- `InboxFilters.tsx`: uma opção "Grupos" que manda `is_group=true` para a listagem. No handler de conversas, aceite `is_group` na query (Zod, `z.enum(["true","false"]).optional()`) e aplique `.eq("is_group", q.is_group === "true")` quando presente. Sem o filtro, a lista mostra tudo, como hoje.

- [ ] **Step 5: Rodar**

Run: `pnpm exec vitest run components/inbox app/api/v1/conversations`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add components/inbox app/api/v1/conversations lib/types/messaging.ts
git commit -m "feat(grupos): inbox mostra a etiqueta de grupo, quem mandou e o filtro Grupos"
```

---

### Task 11: A IA nunca responde em grupo (prova explícita)

**Files:**
- Test: `tests/unit/ia-nunca-responde-grupo.test.ts` (novo)

**Interfaces:**
- Consumes: `drain.ts` (guarda existente de `is_group`), `ai-response-worker.handler.ts`.

- [ ] **Step 1: Teste**

```ts
// tests/unit/ia-nunca-responde-grupo.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aiResponseHandler } from "@/workers/ai-response-worker.handler";

describe("a IA nunca responde em grupo", () => {
  it("o worker de resposta não escuta o evento de grupo", () => {
    expect(aiResponseHandler.events).not.toContain("message.group_received");
    expect(aiResponseHandler.events).toEqual(["message.received"]);
  });
  it("o motor do agente mantém a guarda de conversa de grupo (segunda camada)", () => {
    const drain = readFileSync("lib/agent-engine/edge/crm/drain.ts", "utf8");
    expect(drain).toMatch(/is_group !== false/);
  });
});
```

- [ ] **Step 2: Rodar**

Run: `pnpm exec vitest run tests/unit/ia-nunca-responde-grupo.test.ts`
Expected: PASS (é prova do estado; a Task 1 já tirou `message.received` de grupo).

- [ ] **Step 3: Sabotar**

Acrescente `"message.group_received"` à lista de `aiResponseHandler.events`. Previsto: vermelho. Restaure.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/ia-nunca-responde-grupo.test.ts
git commit -m "test(grupos): a IA nunca responde em grupo, em duas camadas"
```

---

### Task 12: Doutrina, fragmento e portões completos

**Files:**
- Modify: `CLAUDE.md` (seção WAHA, linha "Grupos: SKIP CRM binding…")
- Modify: `AGENTS.md`, se ele repetir essa linha
- Create: `.changes/grupos-na-inbox.md`

- [ ] **Step 1: Atualizar a doutrina**

Troque a linha de grupos da seção WAHA do `CLAUDE.md` por:

```markdown
- Grupos: entram **só os ligados** em Conexões › Grupos (`channel_session_groups`). O grupo ligado vira conversa `is_group` com um contato `kind = 'whatsapp_group'` que nunca entra em funil, lista, campanha ou IA; o remetente é `p.author` (nunca `p.from`), gravado em `messages.metadata.group_sender` (`lib/messaging/remetente-de-grupo.ts`). Para conversa de grupo o banco emite `message.group_received`, e não `message.received`, e o roteamento automático pula grupo. O filtro `ignore.groups` do WAHA é propriedade desta funcionalidade (`definirRecebimentoDeGrupos`); compatibilidade e convergência não o tocam. Spec: `docs/superpowers/specs/2026-09-23-grupos-na-inbox-design.md`
```

`grep -n "SKIP CRM binding" AGENTS.md`: se aparecer, faça a mesma troca.

- [ ] **Step 2: Fragmento**

```markdown
---
impacto: capacidade_nova
secao: adicionado
titulo: Grupos de clientes no chat, com resposta dos atendentes
---

Em **Conexões**, o botão **Grupos** de cada número conectado por QR Code lista os grupos em que ele está. Cada grupo tem uma chave, e todos vêm desligados. Os grupos ligados aparecem no chat com a etiqueta **Grupo**, mostram quem mandou cada mensagem e podem ser respondidos pelos atendentes como qualquer conversa. **A IA nunca responde em grupo**, e grupo não vira negócio no funil, não entra em campanha nem em listas de contatos. Só gerente e administrador ligam grupos. Ao ligar o primeiro grupo de um número, o WhatsApp dele passa a enviar as mensagens de todos os grupos para o sistema, que descarta os não escolhidos. Ao desligar o último, tudo volta a ser como antes. Entram só as mensagens que chegarem depois de ligar.
```

Run: `pnpm release:conferir`
Expected: o fragmento aparece na lista, sem erro de forma.

- [ ] **Step 3: Portões completos**

```bash
rm -f tsconfig*.tsbuildinfo; pnpm typecheck; echo exit=$?
pnpm lint; echo exit=$?
pnpm lint:channels; echo exit=$?
pnpm test:unit > /tmp/vt.log 2>&1; echo exit=$?
grep -aE "Test Files|Tests |Errors " /tmp/vt.log | tail -3
grep -aE "^ *FAIL " /tmp/vt.log | sed 's/ > .*//' | sort | uniq -c
pnpm test:db; echo exit=$?
```

Expected: typecheck, lint e `lint:channels` com exit 0. Em `test:unit`, compare a lista de arquivos vermelhos com a da `main` rodada nesta mesma máquina (neste Windows já existem falhas que não são desta mudança): **nenhum arquivo vermelho novo**. `test:db` com exit 0.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md .changes/grupos-na-inbox.md
git commit -m "docs(grupos): doutrina de grupos na inbox e nota de versão"
```

---

### Task 13: Prova na tela (DoD 12)

Com o ambiente local no ar (`docker compose -f docker-compose.local.yml --env-file .env.local up -d --build`), o número **de teste** conectado e **um grupo de teste criado para isso**, com um segundo celular dentro. Nunca um grupo de clientes reais.

**Files:**
- Create: `.superpowers/evidence/grupos-na-inbox/2026-09-23/*.png`
- Modify: `docs/testing/user-journey-map.md` (casos e resultado)

- [ ] **Step 1: Ligar o grupo** em Conexões › Grupos, pelo navegador, logado como admin. Captura: a lista com o grupo de teste ligado e o aviso de volume.
- [ ] **Step 2: Mensagem do segundo celular no grupo** aparece na inbox com a etiqueta "Grupo" e o nome de quem mandou. Captura.
- [ ] **Step 3: Resposta pela inbox** chega no grupo (confira no celular). Captura da inbox.
- [ ] **Step 4: "parar" no grupo**: confira no banco que o contato do grupo segue com `is_blocked = false` e que nenhuma execução de agente foi criada:

```bash
MSYS_NO_PATHCONV=1 docker run --rm --network host postgres:15-alpine psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -Atc "select kind,is_blocked from contacts where kind='whatsapp_group'; select event_type,count(*) from event_log where created_at > now()-interval '10 minutes' and event_type like 'message.%received' group by 1;"
```

Expected: `whatsapp_group|f`; só `message.group_received` para as mensagens do grupo.
- [ ] **Step 5: Desligar o grupo** e mandar outra mensagem: ela não aparece. Captura.
- [ ] **Step 6: Registrar** em `docs/testing/user-journey-map.md` uma jornada "Grupos na inbox" com os 5 casos e o resultado, e commitar as evidências:

```bash
git add .superpowers/evidence/grupos-na-inbox docs/testing/user-journey-map.md
git commit -m "test(grupos): prova na tela da jornada de grupos na inbox"
```

---

## Fora deste plano (do spec)

Histórico anterior ao ligar; lista de atendentes por grupo (a saída 2); moderação, membros e
criar ou sair de grupo; grupos em canais `limited`.
