import { createHash, randomBytes } from "node:crypto";

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Emite (ou reemite) a API key `dsk_...` de uma organização para uma
 * integração externa — mesmo formato/hash de
 * `app/api/v1/settings/api-tokens/route.ts` (`dsk_<prefix>_<secret>`, SHA256
 * em `token_hash`, plaintext nunca persistido).
 *
 * Sem "recuperar a mesma chave depois": como só o hash fica no banco, uma
 * chamada repetida (replay do provisionamento) revoga a chave anterior desta
 * integração e emite uma nova — nunca duas chaves vivas para o mesmo par
 * (org, integração), e nunca a promessa de devolver texto que não existe mais.
 *
 * ## Os escopos, e por que a chave sem eles não abre NADA
 *
 * Todo consumidor de um bearer `dsk_` cobra `mcp:read` ou `mcp:write`: o MCP
 * (`lib/mcp/server.ts:73`, e os dois são os únicos valores de `requiresScope`
 * nas ferramentas), `app/api/v1/contacts` e o `resolveAuthDual` das rotas de
 * mensagens e conversas. Sem eles a autenticação passa e o despacho devolve
 * 403 `Token missing required scope` — a organização nasceria inoperável pela
 * chave entregue para operá-la. O precedente que funciona ponta a ponta é
 * `lib/ai/runtime/mcp_token.ts:112-118`.
 *
 * ## O papel é `agent`, e o recorte é DELIBERADO (decisão do dono, 19/09)
 *
 * A chave é de MÁQUINA e nasce numa empresa recém-criada, então vale o menor
 * privilégio: `role:agent` (rank 2) já cobre 46 das 63 ferramentas — alimentar
 * dados e conversar, que é o que um parceiro precisa.
 *
 * As 17 de fora são as de `ai_operator` (10) e `manager` (7): configurar
 * agente e ação de gestão. Ninguém ganha isso por provisionamento automático.
 * **Quem precisar de mais emite uma chave pela tela** (Configurações › Chaves
 * de API), onde um humano da empresa decide o papel — não é esquecimento aqui,
 * é o caminho.
 *
 * `scopesRole` (`lib/mcp/auth.ts`) usa o MAIOR `role:` da lista; o teste ao
 * lado fixa o conjunto emitido, então acrescentar `role:manager` sem querer
 * reprova.
 *
 * ## Não há `actor:ai_agent`, e a AUSÊNCIA é a decisão (decisão do dono, 19/09)
 *
 * O parceiro é uma INTEGRAÇÃO, não um agente de IA. `deriveActor`
 * (`lib/mcp/auth.ts:64`) escolhe a espécie do ator pela PRESENÇA de
 * `actor:ai_agent`: com ele, `{ type: "ai_agent" }`; sem ele, `{ type:
 * "api_token" }` — a variante que `lib/api/handlers/types.ts:57` criou
 * exatamente para "token de servidor sem escopo de agente". Não existe escopo
 * que LIGUE `api_token`; ele é o caminho de quem não se declara agente.
 *
 * Três coisas quebravam com o escopo posto:
 *
 * 1. **A linha do tempo atribuía à IA o que um sistema parceiro fez.**
 *    `lib/operacao/autoria.ts:57` devolvia `"ai"` e
 *    `lib/leads/activity-emitter.ts:131` gravava `kind: "ai"` com `agentId:
 *    null` — "alterado pelo assistente" na tela, sem assistente nenhum. É o
 *    mesmo defeito que a #866 já consertou em `messages.sent_via`, onde
 *    `origemDaMensagem` manda `api_token` para `"system"` justamente porque
 *    chamar integração de IA inflava o número do agente no painel.
 * 2. **`crm_resume_agent` ficava barrada.** `lib/mcp/tools/escalacao.ts:315`
 *    lança `resume_requires_person` para ator `ai_agent` — e essa ferramenta é
 *    `requiresRole: "agent"`, ou seja, está DENTRO das 46 que esta chave
 *    promete. A regra ali é "o agente não desfaz a própria passagem"; um
 *    parceiro que não fez passagem nenhuma não é o alvo dela.
 * 3. **`run_id` mentia.** Sem nenhum `agent_run:` na lista, `deriveActor` cai
 *    no fallback `runId = tokenId`, e `lib/mcp/tools/handoff.ts:91` gravava o
 *    id do TOKEN na chave `run_id` — um id que não existe em `ai_agent_runs`.
 *
 * ⚠️ E o recorte NÃO encolhe: o despacho do MCP barra por `ensureScope` +
 * `ensureRole` (`lib/mcp/server.ts:73-74`), nunca por espécie de ator. As 46
 * ferramentas de `role:agent` continuam as mesmas 46 — `crm_resume_agent`
 * deixa de ser recusada no handler, que é o item 2 acima.
 */
export async function rotateIntegrationApiKey(input: {
  organizationId: string;
  createdBy: string;
  /** Escopo que marca a origem, ex.: `integration:clinicfx`. Também filtra revogação. */
  integrationScope: string;
  /** Nome da chave na tela de chaves de API da organização. */
  name: string;
  requestId?: string;
}): Promise<string> {
  const admin = createAdminClient();

  // `scopes` é jsonb (baseline.sql:1266), e o `.contains` do postgrest-js
  // serializa ARRAY como `cs.{a,b}` — literal de array do Postgres, que o `@>`
  // de jsonb não aceita. A forma de STRING passa o valor cru, então aqui vai o
  // JSON pronto. Uma sonda que não casa devolveria "não há chave anterior" e a
  // revogação viraria silêncio.
  const { data: previous, error: erroDaBusca } = await admin
    .from("api_tokens")
    .select("id")
    .eq("organization_id", input.organizationId)
    .is("revoked_at", null)
    .contains("scopes", JSON.stringify([input.integrationScope]));

  // Falha FECHADA: não dá para emitir chave nova prometendo que a anterior
  // deixou de valer sem saber se existe anterior. O chamador responde 500.
  if (erroDaBusca) {
    throw new Error(`rotateIntegrationApiKey: busca da chave anterior falhou: ${erroDaBusca.message}`);
  }

  if (previous && previous.length > 0) {
    const ids = previous.map((t) => t.id);
    // `.is("revoked_at", null)` no UPDATE: entre a leitura e a escrita alguém
    // pode ter revogado, e auditar de novo afirmaria um efeito que não houve.
    // `.select("id")` porque a auditoria sai SÓ para o que o banco devolveu —
    // era o caminho em que `token.revoked` era gravado incondicionalmente e o
    // log passava a afirmar o contrário do banco.
    const { data: revogadas, error: erroDaRevogacao } = await admin
      .from("api_tokens")
      .update({ revoked_at: new Date().toISOString(), revoked_by: input.createdBy })
      .in("id", ids)
      .is("revoked_at", null)
      .select("id");

    if (erroDaRevogacao) {
      throw new Error(
        `rotateIntegrationApiKey: revogação da chave anterior falhou: ${erroDaRevogacao.message}`,
      );
    }

    for (const linha of revogadas ?? []) {
      void audit({
        action: "token.revoked",
        actorUserId: null,
        organizationId: input.organizationId,
        resourceType: "api_token",
        resourceId: linha.id,
        requestId: input.requestId,
        bypassedRls: true,
        metadata: {
          reason: "provisioning_replay",
          integration: input.integrationScope,
          owner_user_id: input.createdBy,
        },
      });
    }
  }

  const prefix = `dsk_${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(32).toString("base64url");
  const plaintext = `${prefix}_${secret}`;
  const tokenHash = createHash("sha256").update(plaintext).digest();
  // Sem `actor:ai_agent` DE PROPÓSITO — ver "a AUSÊNCIA é a decisão" no
  // cabeçalho. É a ausência que faz `deriveActor` devolver `api_token`.
  const scopes = ["mcp:read", "mcp:write", "role:agent", input.integrationScope];

  const { data: created, error } = await admin
    .from("api_tokens")
    .insert({
      organization_id: input.organizationId,
      created_by: input.createdBy,
      name: input.name,
      prefix,
      token_hash: `\\x${tokenHash.toString("hex")}`,
      scopes,
    })
    .select("id")
    .single();

  if (error || !created) {
    throw new Error(`rotateIntegrationApiKey: insert falhou: ${error?.message}`);
  }

  // O ator é a MÁQUINA, não o dono da organização: quem chamou é um sistema de
  // fora, e `createdBy` é só a conta que a linha do banco exige. Creditar um
  // humano por ação que ele não fez é o que `actorAuditPayload` já evita nas
  // rotas de máquina (`app/api/v1/contacts/_handler.ts:61-78`).
  void audit({
    action: "token.created",
    actorUserId: null,
    organizationId: input.organizationId,
    resourceType: "api_token",
    resourceId: created.id,
    requestId: input.requestId,
    bypassedRls: true,
    metadata: { name: input.name, prefix, scopes, owner_user_id: input.createdBy },
  });

  return plaintext;
}
