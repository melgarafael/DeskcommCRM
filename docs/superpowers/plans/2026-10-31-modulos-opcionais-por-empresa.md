# Módulos opcionais **por empresa** — ligar por tenant, sem subir instalação por cliente

Issue: #3868. Base medida: `origin/main` **`9a1467d02a`** (31/10/2026). Este plano **não autoriza merge nem deploy**: descreve o desenho, entrega o código da fatia 1 e explicita as decisões que são do mantenedor.

## 1. O pedido, em uma frase

Hoje `/admin/sistema` liga um módulo **para a instalação inteira** — "vale para todas as empresas hospedadas aqui". Quem revende quer **escolher o cliente**: ligar `crm_b2b` para a empresa A e não para a B, sem subir uma VPS por cliente.

## 2. Por que isso importa num SaaS multi-tenant

Não é simetria de tela. É o que separa "instalação com várias empresas dentro" de **produto vendável por assinatura**:

| O que muda na prática | Hoje | Com a fatia 1 |
|---|---|---|
| **Comercial** | o módulo é do servidor: ligar para um cliente é ligar para todos — não existe plano "com B2B" e "sem B2B" no mesmo servidor | cada empresa tem o seu conjunto; o plano pode ser diferente por cliente |
| **Risco** | um módulo que abre porta (banco externo, IA, cobrança) só pode ser liberado globalmente — o cliente que não paga por ele também o recebe | o módulo abre só onde foi vendido; a superfície de risco acompanha o contrato |
| **Onboarding** | cliente novo entra no servidor com o que o servidor tem | entra com o que **ele** contratou; sem desligar nada de ninguém |
| **Suporte** | "desliga essa função que eu não uso" vira decisão de servidor e afeta os outros clientes | é uma linha na empresa dele |
| **Custo** | não há como oferecer versão reduzida sem separar servidor | o mesmo servidor hospeda planos diferentes — a infraestrutura é compartilhada de verdade |
| **LGPD/isolamento** | módulo ligado globalmente processa dado de empresa que não o contratou | o dado só é processado onde o módulo está ligado |
| **Evolução** | toda feature opcional nova é uma decisão global e irreversível na prática | feature nova nasce desligada e é vendida por empresa |

O argumento decisivo é o segundo: **hoje o interruptor é global porque o gate não conhece a organização** (`lib/instalacao/modulos.ts:195`). Enquanto for assim, "plano por cliente" é impossível sem separar servidor — que é justamente o que um SaaS multi-tenant não quer.

## 3. O estado medido

| Peça | Onde | Fato |
|---|---|---|
| Gate | `lib/instalacao/modulos.ts:195` | `moduloLigado(db, modulo)` — **sem organização** no parâmetro |
| Chamadores | `app/`, `lib/`, `components/` | **60 arquivos** chamam `moduloLigado`/`modulosLigados` |
| Flags | `platform_config` (0341), `CHAVE_DO_MODULO`:94 | `MODULO_<NOME> = 'ligado'`; ausente/erro ⇒ desligado (**falha fechada**) |
| Módulos de tabela | `modulos_instalados` + `fn_modulo_instalar` | `honorarios`, `financeiro` (ADR-0002) |
| Lista | `MODULOS_OPCIONAIS` | 11 flags + 2 de tabela |
| **Só instalação** | `lib/instalacao/modulos.ts:271` | `MODULOS_SO_DA_INSTALACAO = ["cobranca"]` — **já existe** a noção de módulo que não desce para a empresa |
| Por empresa | — | **nada**: nenhuma tabela, coluna ou chave em `organizations.settings` |
| Menu | `lib/navigation/interface.ts:118` | `permitidos()` — um único ponto filtra a navegação |
| Memo | `lib/instalacao/modulos.ts:210` | `moduloLigadoComMemo`, 30 s, caminho quente do agente |

**Três fatos que decidem o desenho:**

1. `MODULOS_SO_DA_INSTALACAO` já existe. O desenho não precisa inventar a exceção — precisa **respeitá-la**, e ela é o lugar onde se declara "este módulo não desce".
2. O gate é **fail-closed** e sem memo na maioria dos caminhos. Um override por empresa não pode virar um `select` a mais por request: a leitura por empresa entra no mesmo `Promise.all` que já existe, e no caminho quente herda o memo.
3. São 60 chamadores. Um PR que mude os 60 é um big bang irrevisável. A fatia 1 entrega o **dado** e a **decisão**; o enforcement entra por módulo.

## 4. As três regras de resolução (e por que essa ordem)

```
1. instalação desligada  → desligado em TODO lugar   (teto; nunca se contorna por baixo)
2. linha da empresa      → vence a instalação        (ligado/desligado explícito)
3. sem linha da empresa  → herda a instalação        (ninguém que não configurou sente nada)
```

- **A instalação é teto, não piso.** Deixar a empresa ligar o que o dono do servidor não ligou cria porta de rede/credencial que ninguém autorizou — e contradiz a doutrina da 0341 ("só o valor `ligado` liga; linha ausente = desligado"). Se um dia a política virar "piso", muda **uma linha** do resolvedor, não o desenho.
- **Ausência de linha herda.** É o que garante que a fatia 1 não muda o comportamento de nenhuma instalação existente: sem linha, o resultado é idêntico ao de hoje, bit a bit.
- **`MODULOS_SO_DA_INSTALACAO` não aceita linha.** `cobranca` decide preço/limite de todos; deixar uma empresa "desligar" a cobrança desligaria o teto de gasto de quem paga. A escrita recusa (422) e o read devolve o valor da instalação.

## 5. Global constraints

- **Tripla de banco:** migration nova + bloco idempotente no fim de `supabase/baseline.sql` + linha `-- manifest:` no cabeçalho do `.sql` (`CONTRIBUTING.md:78`). O kit self-host aplica **só o baseline**.
- **Server-only:** RLS ligada, **sem policy** para `authenticated`; `revoke all … from public, anon, authenticated` + `grant … to service_role` (mesmo molde da `avisos`, migration 9059).
- **RBAC:** quem escreve é `is_platform_admin` (a tela é `/admin`, não `/app`). Tenant admin **não** liga módulo para si — isso é do dono do servidor enquanto a flag for teto.
- **Auditoria:** toda escrita entra em `lib/audit/actions.ts` (tipo fechado) — desligar um módulo de uma empresa é mudança de contrato, tem de deixar rastro.
- **i18n PT+ES obrigatório** em toda string nova (`lib/i18n/dicionario.ts`), inclusive o rótulo de estado.
- **Zod na borda**, `organization_id` sempre da sessão/param validado — nunca do corpo.
- **Nada muda para quem não usar:** sem linha, comportamento atual preservado; flag da instalação intocada.

## 6. Fatia 1 — o dado e a decisão (este PR)

### Tarefa 1 — migration `9084_organizacao_modulos.sql`

> Número medido em `9a1467d02a`: maior sufixo **9083**. Medir **de novo** na hora do PR (`scripts/checar-colisao-de-migration.sh`) — a fila anda ~1 por dia e a colisão se resolve antes, não depois.

```sql
-- manifest: Módulo opcional POR EMPRESA — tabela `organization_modules` (organizacao, modulo, estado). O gate de módulo é da instalação (`platform_config`/`modulos_instalados`); esta tabela permite que UMA empresa esteja fora de um módulo que a instalação tem, sem mudar as outras. Server-only: RLS ligada, sem policy; leitura/escrita só pelo service role. Resolução: instalação desligada vence tudo; linha da empresa vence a instalação; sem linha, herda.
create table if not exists public.organization_modules (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  modulo text not null,
  estado text not null check (estado in ('ligado', 'desligado')),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  primary key (organization_id, modulo)
);

comment on table public.organization_modules is
  'Módulo opcional POR EMPRESA (issue #3868). Sem linha = herda a instalação. Instalação desligada vence linha. Módulo de MODULOS_SO_DA_INSTALACAO não aceita linha.';
comment on column public.organization_modules.estado is
  'ligado|desligado. A ausência de linha é o terceiro estado (herda) — não existe linha "herda" de propósito: apagar a linha é como se volta a herdar.';

alter table public.organization_modules enable row level security;

revoke all on public.organization_modules from public, anon, authenticated;
grant select, insert, update, delete on public.organization_modules to service_role;

-- Quem já estava fora do módulo continua fora; a fatia 1 não escreve linha nenhuma.
-- (Sem backfill: a ausência de linha É o comportamento de hoje.)
```

### Tarefa 2 — espelho no `baseline.sql`

Mesmo `create table if not exists` + `comment` + `alter … enable row level security` + `revoke`/`grant`, no bloco do fim do arquivo. Sem isso, **instalação nova nasce sem a tabela** e o resolvedor falha fechado (ninguém consegue desligar por empresa). É o erro que o `test:db` pega e o gate não.

### Tarefa 3 — tipos

`lib/database.types.ts`: `organization_modules` em `Tables`, Row/Insert/Update (`modulo: string`, `estado: "ligado" | "desligado"`).

### Tarefa 4 — `lib/instalacao/modulos-da-empresa.ts` (novo)

```ts
/**
 * MÓDULOS POR EMPRESA (issue #3868).
 *
 * O gate da instalação (`modulosLigados`) responde "este módulo existe neste
 * servidor?". Esta camada responde a pergunta seguinte, que é a do cliente:
 * "esta empresa PODE usá-lo?".
 *
 * ─── As três regras, nesta ordem ────────────────────────────────────────────
 * 1. instalação desligada  → desligado (teto: a empresa não abre porta que o
 *    dono do servidor não abriu);
 * 2. linha da empresa      → vence (ligado/desligado explícito);
 * 3. sem linha             → herda (é o que faz esta camada não mudar nada hoje).
 *
 * ─── Por que tabela e não `organizations.settings` ──────────────────────────
 * `settings` é jsonb livre, escrito por várias telas; um módulo ligado lá
 * dentro não teria chave primária, nem checagem de valor, nem cascade ao apagar
 * a empresa, e a leitura ficaria sem índice. A tabela custa uma linha por
 * exceção — e as exceções são poucas por definição.
 *
 * ─── Por que memo de processo é seguro aqui ─────────────────────────────────
 * O memo da instalação (`moduloLigadoComMemo`, 30 s) já aceita defasagem de 30 s
 * para o caminho quente do agente. O override por empresa usa o MESMO memo, com
 * a chave composta `org:modulo`: desligar uma empresa vale no próximo turno do
 * agente, no máximo 30 s depois — o mesmo contrato que já existe para o servidor.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import {
  MODULOS_SO_DA_INSTALACAO,
  modulosLigados,
  type ModuloOpcional,
} from "@/lib/instalacao/modulos";

export type EstadoDoModuloDaEmpresa = "ligado" | "desligado";

/** O que a empresa decidiu, e nada além: ausência = herda. */
export async function overridesDaEmpresa(
  db: SupabaseClient,
  organizationId: string,
): Promise<Map<ModuloOpcional, EstadoDoModuloDaEmpresa>> {
  try {
    const { data, error } = await db
      .from("organization_modules")
      .select("modulo, estado")
      .eq("organization_id", organizationId);
    if (error) {
      // Falha fechada, como a instalação: sem leitura, ninguém ganha módulo novo.
      logger.warn("módulos da empresa: leitura recusada — usando só a instalação", {
        organization_id: organizationId,
        codigo: error.code,
      });
      return new Map();
    }
    const mapa = new Map<ModuloOpcional, EstadoDoModuloDaEmpresa>();
    for (const linha of (data ?? []) as Array<{ modulo: string; estado: EstadoDoModuloDaEmpresa }>) {
      mapa.set(linha.modulo as ModuloOpcional, linha.estado);
    }
    return mapa;
  } catch (erro) {
    logger.warn("módulos da empresa: leitura falhou — usando só a instalação", {
      organization_id: organizationId,
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return new Map();
  }
}

/** Os módulos que valem para UMA empresa, já com as três regras aplicadas. */
export async function modulosDaEmpresa(
  db: SupabaseClient,
  organizationId: string,
): Promise<ModuloOpcional[]> {
  const [daInstalacao, overrides] = await Promise.all([
    modulosLigados(db),
    overridesDaEmpresa(db, organizationId),
  ]);
  const ligados = new Set<ModuloOpcional>(daInstalacao);
  for (const [modulo, estado] of overrides) {
    // Enquanto a instalação for TETO, o override só REMOVE. `estado === "ligado"`
    // numa instalação desligada não faz nada de propósito (regra 1): é a linha que
    // separa "decidir por empresa" de "abrir porta que o dono do servidor fechou".
    if (estado === "desligado" && ligados.has(modulo)) ligados.delete(modulo);
  }
  return [...ligados];
}

/** A pergunta que as rotas fazem hoje, agora com a empresa no meio. */
export async function moduloLigadoDaEmpresa(
  db: SupabaseClient,
  organizationId: string,
  modulo: ModuloOpcional,
): Promise<boolean> {
  if (MODULOS_SO_DA_INSTALACAO.includes(modulo)) {
    // Não desce para a empresa por desenho: ler o override aqui seria mentir.
    return (await modulosLigados(db)).includes(modulo);
  }
  return (await modulosDaEmpresa(db, organizationId)).includes(modulo);
}
```

**Decisão de leitura, escrita à mão no PR:** `modulosDaEmpresa` faz **uma** leitura de `organization_modules` por chamada (a da instalação já é feita hoje). Não há N+1: a tabela tem PK `(organization_id, modulo)`, e a consulta volta com zero a três linhas no caso real.

### Tarefa 5 — escrita + auditoria (`app/actions/admin/updateModuloDaEmpresa.ts`)

Molde: `app/actions/settings/updateModuloDaInstalacao.ts` (mesma validação, mesma revalidação de caminho).

```ts
"use server";

// ... Zod: { organization_id: uuid, modulo: string, estado: "ligado"|"desligado"|"herdar" }
// 1. requirePlatformAdmin() — esta é a tela da instalação, não do tenant.
// 2. MODULOS_SO_DA_INSTALACAO.includes(modulo) → 422 com mensagem, nunca "ok".
// 3. estado === "herdar" → delete da linha; senão upsert (organization_id, modulo).
// 4. audit("admin.module_org_changed", { organization_id, modulo, de, para }).
// 5. revalidatePath("/admin/sistema").
```

O `estado: "herdar"` é o que evita a tabela virar lixo: a linha só existe enquanto a empresa difere do padrão.

### Tarefa 6 — UI: bloco "Por empresa" em `/admin/sistema`

Na página `app/admin/(protected)/sistema/page.tsx`, **quarto** bloco (depois de Módulos, Comportamento e Depende do servidor):

- `<select>` de empresa (as 50 primeiras por nome; busca quando passar disso — a mesma query de `/admin/tenants`).
- Para a empresa escolhida, a lista de `MODULOS_OPCIONAIS` com **três** estados: **herda** (padrão), **ligado**, **desligado** — e um selo "só da instalação" nos de `MODULOS_SO_DA_INSTALACAO` (sem interruptor, com o motivo).
- Reusa `FormularioDeModulos` (`_form.tsx:418`) para o desenho do interruptor; o que muda é o `onChange` (três estados) e o alvo (empresa).
- **A frase da tela muda junto:** "Tudo o que se liga e desliga nesta instalação, num lugar só. Vale para todas as empresas hospedadas aqui." → acrescentar ", e o que cada empresa usa pode ser ajustado abaixo". Texto atual passa a ser mentira no dia em que a fatia 1 entrar.
- i18n PT+ES das strings novas; `tests/unit/recursos-opcionais-catalogo.test.ts` continua verde (a lista não muda).

### Tarefa 7 — provas

`tests/invariants/modulos-por-empresa.test.ts` (4 casos, Postgres real):

1. **instalação ligada + empresa `desligado`** → `moduloLigadoDaEmpresa` nega, e `moduloLigado` (instalação) continua positivo — as duas perguntas são diferentes.
2. **empresa sem linha** → resultado **idêntico** a `modulosLigados(db)` (o teste compara as duas listas, não só "contém").
3. **instalação desligada + empresa `ligado`** → nega (teto). É o caso que prova que a empresa não contorna o servidor.
4. **migration roda duas vezes** e a tabela existe no `baseline.sql` com RLS ligada e **sem policy** (`pg_policies` vazio para ela).

`tests/unit/modulos-por-empresa-contratos.test.ts`: `estado: "herdar"` vira `delete` (não upsert); `cobranca` recusa escrita; `organization_id` fora do corpo é recusado.

## 7. Fatia 2 — enforcement, sem big bang

Ordem = a distância do usuário:

1. **Menu** (`lib/navigation/interface.ts:118` `permitidos()`): passa a receber `organizationId` e usar `modulosDaEmpresa`. É **um** arquivo e é a mudança visível — o módulo some da navegação daquela empresa.
2. **Rotas de API**, módulo a módulo. Os 60 chamadores caem em três baldes:
   - **~30 rotas de produto** (`app/api/v1/<modulo>/**`) → `moduloLigadoDaEmpresa(db, orgId, …)`, com `orgId` que já vem da sessão hoje;
   - **~15 telas** (server components) → mesma troca, `orgId` do contexto da requisição;
   - **~10 caminhos da instalação** (`/admin/**`, `app/actions/settings/updateModuloDaInstalacao.ts`, cron de cobrança) → **continuam** com `moduloLigado`, porque a pergunta deles é sobre o servidor.
   Cada módulo é um PR pequeno com o seu teste; nenhum exige refactor global.
3. **Catálogo MCP** (`deModuloDesligado`): recebe a organização da tool call.
4. **Caminho quente** (`moduloLigadoComMemo`): memo com chave `org:modulo`; sem isso, o turno do agente paga uma leitura por mensagem.

**Critério de aceite da fatia 2, por módulo:** desligar na empresa A esconde do menu **e** recusa na API da A, e não muda nada na B. Enquanto os dois lados não estiverem trocados para aquele módulo, ele **não** aparece no bloco por empresa (ou aparece com aviso) — tela que mostra o que o servidor nega é pior que tela nenhuma.

## 8. Fatia 3 — módulos de tabela (fora deste plano)

`honorarios` e `financeiro` provisionam **esquema** por instalação (`fn_modulo_instalar`, `fn_financeiro_provisionar`) e entram na catraca de LGPD do #1902. Desligar por empresa aí é decidir o que fazer com dado já provisionado — issue própria, com aviso e backup. Fica declarado fora de propósito.

## 9. Compatibilidade

| Situação | Antes | Depois |
|---|---|---|
| Instalação existente, nenhuma linha nova | módulo X ligado na instalação | **idêntico** |
| Instalação nova | — | tabela existe, vazia; comportamento idêntico |
| Empresa criada depois | herda | herda |
| Empresa apagada | — | `on delete cascade` leva as linhas junto |
| Kit self-host | aplica só o baseline | baseline traz a tabela (tarefa 2) |

Nenhum backfill: a ausência de linha **é** o comportamento de hoje.

## 10. Anti-escopo

- Não muda o gate da instalação, nem `platform_config`, nem `modulos_instalados`.
- Não cria plano/preço por módulo (a tabela é a **base** para isso um dia, não a política).
- Não permite que admin de tenant ligue módulo para si (enquanto a flag for teto).
- Não mexe em `cobranca` (declarada só da instalação).
- Não migra dado nenhum entre empresas.

## 11. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Alguém achar que desligar apaga dado | texto na tela e no comentário da coluna: **esconde, não apaga**; religar devolve |
| Ler duas vezes por request | PK + índice implícito; uma consulta por request, no mesmo `Promise.all` |
| Override virar segunda fonte de verdade | só três estados, `herdar` = `delete`; a instalação continua sendo o teto |
| Módulo novo em `MODULOS_OPCIONAIS` sem texto | o `Record<ModuloOpcional, …>` do catálogo não compila (mecanismo que já existe) |
| Empresa "ligar" o que o servidor não tem | regra 1 do resolvedor + teste 3 |
| Enforcement incompleto (menu sem API) | critério de aceite da fatia 2, por módulo |

## 12. Perguntas ao mantenedor

1. **A flag da instalação é teto ou padrão?** O plano assume **teto**. Se for piso (empresa pode ligar o que o servidor não ligou), muda uma linha do resolvedor e o risco é credencial/porta de rede fora do controle do dono do servidor.
2. **Desligar por empresa esconde ou apaga?** O plano assume **esconde**. Apagar merece issue própria.
3. **Quem pode escrever?** O plano assume **só `is_platform_admin`** (é a tela da instalação). Se o admin da empresa puder se autoatender ("quero desligar o B2B"), é outra decisão — e muda o RBAC da action, não a tabela.

## 13. Como conferir cada afirmação

```bash
git show origin/main:lib/instalacao/modulos.ts | sed -n '190,200p'   # assinatura sem org
git grep -l 'moduloLigado(' origin/main -- app lib components | wc -l # 60 arquivos
git show origin/main:lib/instalacao/modulos.ts | sed -n '268,272p'    # MODULOS_SO_DA_INSTALACAO
git show origin/main:lib/navigation/interface.ts | sed -n '110,130p'  # permitidos()
git show origin/main:'app/admin/(protected)/sistema/page.tsx' | grep -n 'bloco-'  # os três blocos
git show origin/main:'app/admin/(protected)/sistema/_form.tsx' | grep -n 'Módulos opcionais'
bash scripts/checar-colisao-de-migration.sh                            # antes de escrever a 9084
```
