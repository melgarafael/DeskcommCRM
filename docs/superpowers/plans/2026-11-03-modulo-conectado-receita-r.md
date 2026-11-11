# Receita das fatias R (R1, R2, R3) — converter uma rota para aceitar token

Documento de apoio dos planos `…-p2-r1-configuracao.md`, `…-p3-r2-operacao.md` e `…-p4-r3-leitura-e-analise.md`.
Cada tarefa desses planos aplica esta receita às rotas da sua tabela. O que está aqui vale para todas;
o que muda por rota está na tabela do plano.

**Spec:** `docs/specs/33-spec-modulo-conectado.md`, seção "R — Converter as rotas, por área" (os itens 1 a
6 de "Cada rota convertida") e a lista de negação da F3.

**Medido em `origin/main` `fe7a11457`** (03/11/2026), com os scripts de inventário da sessão. Antes de cada
tarefa, o passo 1 refaz a medição das rotas daquela área.

## Pré-requisito

A fatia 1 (R0) mesclada no fork, ou a branch dela como base. Ela entrega:
- a cerca `tests/unit/rotas-bearer-tem-porta-no-proxy.test.ts`;
- o cliente falso `tests/unit/helpers/cliente-admin-falso.ts` (interface abaixo).

## O cliente falso (entregue na R0, usado aqui)

```ts
type CadeiaRegistrada = {
  tabela: string;
  operacao: "select" | "insert" | "update" | "upsert" | "delete";
  filtros: Array<[coluna: string, valor: unknown]>;
  payload?: unknown;
};
criarClienteAdminFalso(opts: {
  orgDona: string;
  linhas?: Record<string, Record<string, unknown>[]>;
  rpc?: Record<string, unknown>;
}): { cliente: unknown; cadeias: CadeiaRegistrada[]; rpcs: { nome: string; args: Record<string, unknown> }[]; uploads: { bucket: string; caminho: string }[] };
cadeiasForaDaOrganizacao(cadeias: CadeiaRegistrada[], org: string): CadeiaRegistrada[];
rpcsForaDaOrganizacao(rpcs: { nome: string; args: Record<string, unknown> }[], org: string): string[];
```

- Um `select` só devolve linhas de `linhas[tabela]` que batem com **todos** os `eq`. Sem
  `eq("organization_id", …)`, devolve vazio e a cadeia fica registrada.
- `cadeiasForaDaOrganizacao` acusa toda cadeia sem `eq("organization_id", org)` e todo
  `insert`/`upsert` cujo payload não tem `organization_id === org`.
- `rpcsForaDaOrganizacao` acusa toda chamada cujo `p_org`/`p_organization_id` difere de `org`.
- Método de cadeia que o falso não conhece lança `método X não suportado pelo cliente falso`. Quem
  precisar estende o falso no mesmo PR.

## Os mocks de todo teste de token

- `@/lib/supabase/server`: `createClient` **lança** `"cliente de sessão usado no ramo do token"`.
- `@/lib/auth/server`: `loadAuthUser` **lança** a mesma mensagem.
- `@/lib/supabase/admin`: `createAdminClient` devolve o `cliente` do falso.
- `@/lib/mcp/auth`: `validateBearerToken` mockado (molde de `app/api/v1/conversations/[id]/media/route.test.ts:21-48`).
- `@/lib/ai/dispatcher/rate-limit`: `checkRateLimit` devolve `{ allowed: true }`, salvo no caso do teto.
- `@/lib/impersonate/support`: `requireSupportWrite` devolve `null`.

Assim, toda função de `lib/` que ainda use a sessão por dentro quebra o teste de token, sem precisar
rastrear a função à mão.

## O teste da área

Arquivo: `tests/unit/token-por-area/<area>.test.ts`, guiado por tabela:

```ts
type Caso = {
  rota: string;            // "app/api/v1/pipelines/[id]/stages/route.ts"
  metodo: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  caminho: string;         // "/api/v1/pipelines/<UUID_A>/stages"
  params?: Record<string, string>;
  corpo?: unknown;         // válido para o Zod da rota
  linhas: Record<string, Record<string, unknown>[]>; // recurso da organização A
  papel: "viewer" | "agent" | "manager" | "admin";   // o da tabela do plano
  escopo: string;          // o da regra de escopo abaixo
  papelDoToken?: "admin";  // quando houver tokenRole
};
```

Para cada caso, seis testes:

| Teste | Esperado |
|---|---|
| `"<metodo> <caminho>: token de A alcança o recurso de A"` | status 2xx; `cadeiasForaDaOrganizacao(cadeias, ORG_A)` vazio; `rpcsForaDaOrganizacao(rpcs, ORG_A)` vazio |
| `"… token de B não alcança o recurso de A"` | 404 (ou lista vazia num `GET` de coleção); nenhuma escrita registrada; nenhuma cadeia fora de `ORG_B` |
| `"… token sem o escopo é recusado"` | 403 |
| `"… token abaixo do papel é recusado"` | 403 (papel um degrau abaixo de `papelDoToken ?? papel`) |
| `"… acima do teto do token → 429"` | 429 com `Retry-After`; nenhuma cadeia registrada |
| `"… sessão continua com o mesmo portão"` | sem `Authorization`, `requireRole` é chamado com `papel` (receita A), ou o portão de hoje é chamado (receita B) |

Um bloco a mais, por área, no molde de `app/api/v1/contacts/[id]/avatar/route.test.ts:337-350`: cada entrada
nova de `PUBLIC_PATHS` dá `true` no caminho com UUID e `false` com id fora da forma de UUID, com sub-path
`/x` e com cada irmão literal do mesmo nível.

## Receita A — rota que usa `requireRole`

Para cada método da tabela marcado com **A**:

1. `requireSupportWrite()` continua onde está, nos métodos de escrita.
2. `requireRole(PAPEL, { requestId, resource })` vira `resolveAuthDual(req, { requestId, resource, role:
   PAPEL, scope, tokenRole })`, com o **mesmo** `PAPEL` (literal ou constante). Trocas: `authz.org.orgId` →
   `authz.organizationId`; `authz.user.id` como autor → `authz.actor.type === "user" ? authz.actor.id : null`;
   `authz.user.idioma` → `authz.idioma ?? IDIOMA_PADRAO`.
3. Logo depois: `const teto = await tetoDeEscritaDoToken(authz, "<resource>", requestId); if (teto) return teto;`,
   em **todo** método convertido, leitura inclusive. É o formato que a cerca
   `tests/unit/rotas-bearer-aplicam-teto-de-escrita.test.ts` cobra, e o precedente de leitura é
   `app/api/v1/contacts/[id]/avatar/route.ts:95`.
4. O cliente do banco é `authz.supabase`. Toda chamada a `createClient()` da rota sai.
5. **Toda** cadeia `.from(t)` filtra `.eq("organization_id", authz.organizationId)`, inclusive as que
   hoje confiam na RLS. Todo `insert`/`upsert` leva `organization_id: authz.organizationId`. Tabela filha
   sem a coluna (conferir no `baseline.sql`): primeiro busca o pai com o filtro de organização e só então
   a filha pelo id do pai.
6. Toda `rpc` recebe a organização de `authz.organizationId`, nunca do corpo ou do path.
7. Audit: `actorUserId: authz.actor.type === "user" ? authz.actor.id : null` e
   `actorApiTokenId: authz.apiTokenId ?? null`. Nenhum `…_by_user_id` recebe id de token.
8. Storage: o caminho do objeto começa com o prefixo de organização que a rota já usa hoje, montado de
   `authz.organizationId`.

## Receita B — rota que usa outro portão (`getUser`, `loadAuthUser`, `orgAtivaDaApi`)

Para cada método marcado com **B**, a sessão fica **byte a byte igual**:

1. O corpo atual que vem depois do portão vira `async function responder(db: SupabaseClient,
   organizationId: string, …)`, no mesmo arquivo.
2. No começo do método: `if (extractBearer(req.headers.get("authorization")))` (de `@/lib/mcp/auth`) →
   `resolveAuthDual(req, { requestId, resource, role: "viewer", scope: "mcp:read" })` + teto +
   `responder(authz.supabase, authz.organizationId, …)`.
3. Sem `Authorization`, o caminho antigo segue e chama o mesmo `responder` com o cliente e a organização
   que ele já resolvia.
4. Os itens 4 a 8 da receita A valem dentro de `responder`.

## Escopo e papel do token

| Fatia | Leitura | Escrita | `tokenRole` |
|---|---|---|---|
| R1 (configuração) | `config:read` | `config:write` | `"admin"` em todos os métodos (precedentes #2194 e #2824) |
| R2 (operação) | `mcp:read` | `mcp:write` | só quando a tool MCP que faz a mesma coisa exige papel maior (`requiresRole` em `lib/mcp/tools/catalogo/*`) |
| R3 (leitura e análise) | `mcp:read` | `mcp:write` | idem R2 |

## A entrada em `PUBLIC_PATHS`

- Uma entrada por caminho, no bloco server-to-server, com comentário curto: quem autentica (a rota, por
  `resolveAuthDual`) e o porquê da âncora, como as vizinhas.
- Id: forma de UUID (`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`, flag `i`). Segmento
  que não é id (`[name]`, `[slug]`, `[tipo]`, `[indice]`): a mesma classe que o Zod da rota aceita; se a
  rota não valida o segmento, ela passa a validar no mesmo PR.
- Sempre `$` no fim.
- Rota com método convertido e método fora: a entrada vale para o caminho, e o método fora continua com
  `requireRole`, que recusa o token sem cookie com 401. O teste da área prova isso com um caso a mais.

## Quando parar (e chamar a sessão do Claude)

- A rota chama uma função do banco que exige sessão (`auth.uid() is null` recusa, ou
  `fn_user_org_ids()`): o método fica fora, com o motivo. Não se cria variante da função nesta fatia.
- A rota usa o id da sessão como **sujeito** (minha presença, minha leitura, assumir para mim), e não como
  autor: o método fica fora.
- Uma tabela que a rota escreve tem coluna de pessoa `NOT NULL` preenchida pela sessão.
- A tabela do plano e o código não batem (rota nova, método novo, portão diferente).

Parar quer dizer: não converter aquele método e registrar no corpo do PR, na seção "Fica de fora".

## O caminho de cada tarefa (um PR por tarefa)

1. **Medir de novo:** `git log --oneline fe7a11457..origin/main -- <arquivos da tarefa>`. Se algo mudou,
   reler a rota e corrigir a linha da tabela antes de seguir.
2. **Teste da área** (vermelho), com um caso por linha da tabela.
3. **Converter** cada método pela receita da tabela.
4. **Entradas** em `PUBLIC_PATHS` e o bloco de borda.
5. **Commit** por área, identidade do `git config`; pré-voo.
6. **CI do fork** (PR interno `--base base/main-do-rafael`, fechado sem mesclar). Nada roda nesta máquina.
7. **Sabotagem pelo CI**, prevista antes: (a) tirar o `eq("organization_id", …)` de uma consulta de uma
   rota → 1 vermelho ("token de B…") naquela rota; (b) tirar uma entrada de `PUBLIC_PATHS` → os vermelhos
   da cerca da R0 e do caso `true` da borda para aquele caminho.
8. **Fragmento** `.changes/<area>-aceita-token.md` (`impacto: capacidade_nova`, `secao: adicionado`).
9. **PR ao `melgarafael/DeskcommCRM`:** o Paulo lê o texto antes. O texto é sobre integração por token, sem
   citar o assistente nem cliente, com o bloco "O que NÃO medi" e a assinatura `— Paulo Lima Jr`.

## Review Focus (vale para as três fatias)

1. **Consulta sem filtro que só a RLS protegia**: some no token, porque o cliente é admin. O teste "token de
   B" com o falso pega cada uma.
2. **`lib/` que cria a sua própria sessão**: o mock que lança pega.
3. **Função do banco tolerante a service role** (`emit_event`, `fn_conversation_assign`,
   `fn_mesclar_contatos`, `fn_contato_pessoal_remove_trechos_do_rag`, `fn_conversa_remove_trechos_do_rag`):
   ela pula a checagem de papel quando `auth.uid()` é nulo, então o papel do `resolveAuthDual` é a única
   barreira. O teste "abaixo do papel" pega.
4. **Irmão literal de carona** numa entrada de `PUBLIC_PATHS`: o bloco de borda pega.
5. **Sessão alterada sem querer**: o teste "sessão continua com o mesmo portão" pega.
