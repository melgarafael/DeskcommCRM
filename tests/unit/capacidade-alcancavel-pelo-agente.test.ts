/**
 * GATE DO PILAR 1 — o papel exigido por uma capacidade é decisão, não descuido.
 *
 * O épico IA 360 promete "a IA tem mãos". Uma capacidade declarada no catálogo,
 * oferecida na tela e ligada pelo dono do negócio, mas recusada em tempo de
 * execução por papel insuficiente, é uma promessa quebrada — e quebrada do pior
 * jeito possível: o modelo recebe `{ error: "Role 'agent' insufficient" }` de
 * volta, segue conversando, e nada aparece na tela do humano dizendo que a
 * ferramenta que ele ligou não existe na prática.
 *
 * ⚠️ O PAPEL DO AGENTE PUBLICADO É `agent`, LITERAL E FIXO, nos dois caminhos
 * que montam o contexto MCP de um agente:
 *   - `lib/ai/runtime/agent.ts` — `auth.role = "agent"`, `scopes: [… "role:agent"]`
 *   - `lib/agent-engine/edge/crm/mcp-tools.ts` — `role: 'agent'`
 * e `lib/ai/runtime/mcp_token.ts` grava `"role:agent"` no token efêmero sem
 * parâmetro para variar. `ensureRole` compara por `ROLE_RANK`, então toda tool
 * com `requiresRole` acima de `agent` é inalcançável para QUALQUER agente
 * publicado.
 *
 * ⚠️ E A RÉGUA NÃO É "TUDO TEM QUE SER ALCANÇÁVEL". Algumas capacidades NÃO
 * devem estar ao alcance da IA, e o que decide é uma medição, não uma opinião:
 * **o papel que a ROTA HTTP equivalente exige**. Onde a rota pede `agent` e a
 * tool pedia `manager`, era divergência — a IA e o humano operando por regras
 * diferentes sobre a MESMA ação (as quatro tools de lead, corrigidas em
 * `bddeeb6`). Onde a rota pede `manager`, restringir a IA é PARIDADE: nem um
 * atendente humano configura aquilo pela tela.
 *
 * Este arquivo mede as duas coisas: que nada ficou fora do alcance por acidente,
 * e que nada entrou no alcance por atalho.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { allTools } from "@/lib/mcp/tools";
import { catalogEntry } from "@/lib/mcp/tools/catalog";
import { ROLE_RANK, type Role } from "@/lib/auth/types";

const RAIZ = join(__dirname, "..", "..");

/**
 * O papel que um agente publicado de fato recebe. Constante local de propósito —
 * ver o controle positivo no fim, que confere que ela ainda descreve o código.
 */
const PAPEL_DO_AGENTE_PUBLICADO: Role = "ai_operator";

/**
 * DÍVIDA MEDIDA em `99cd0fc` e PAGA em `bddeeb6`: `crm_create_lead`,
 * `crm_update_lead`, `crm_move_lead_stage` e `crm_send_whatsapp_message`
 * exigiam `manager` e nenhum agente as alcançava, enquanto as rotas HTTP
 * equivalentes exigem `agent` — um atendente humano fazia pela tela o que a IA
 * não conseguia fazer com o mesmo papel.
 *
 * Vazia agora. A penúltima asserção cobra que ela não envelheça: deixar um nome
 * aqui depois de resolvido mentiria para quem vier.
 */
const INALCANCAVEIS_CONHECIDAS: ReadonlyArray<string> = [];

/**
 * As escritas que são TRABALHO DE ATENDENTE, e por isso exigem só `agent`.
 *
 * ⚠️ ESTA LISTA É O CONTRAPESO DA DÍVIDA ACIMA, e existe porque as duas falhas
 * são simétricas. A dívida caça a tool restrita DEMAIS; esta caça a restrita DE
 * MENOS — alguém baixando `requiresRole` para `agent` "porque senão não
 * funciona", concedendo em silêncio poder de configuração a quem só devia
 * atender. Sem ela, consertar uma inalcançável teria um caminho fácil e errado.
 *
 * Acrescentar um nome aqui é conceder poder. Faça olhando para a rota HTTP
 * equivalente, e diga qual é.
 */
const ESCRITA_QUE_E_TRABALHO_DE_ATENDENTE: ReadonlyArray<string> = [
  // `app/api/v1/leads/` — POST exige `agent`. Um atendente cria negócio pela tela.
  "crm_create_lead",
  // `app/api/v1/leads/[id]/retomar/` — POST exige `agent` (issue #1538).
  "crm_retomar_lead",
  // `app/api/v1/leads/[id]/` — PATCH exige `agent`.
  "crm_update_lead",
  // `app/api/v1/leads/[id]/move/` — exige `agent`. Mover card é o trabalho do dia.
  "crm_move_lead_stage",
  // `app/api/v1/messages/` — exige `agent`. Responder cliente é o trabalho do dia.
  "crm_send_whatsapp_message",
  // `app/api/v1/ai/cases/[id]/reply/` — POST exige `agent`. Registrar no chamado
  // é o trabalho de quem atende (paridade medida na integração do papel novo).
  "crm_add_case_note",
  // `app/api/v1/contacts/[id]/proposals/` — POST exige `agent`, e a paridade é
  // com o PATCH de contato (`app/api/v1/contacts/[id]/`), que também exige
  // `agent`: editar a ficha de um cliente é trabalho de quem atende.
  //
  // O poder concedido aqui é MENOR que o daquela rota, não igual: esta tool não
  // escreve em `contacts` — cria uma linha em `contact_field_proposals` que uma
  // PESSOA precisa confirmar (spec 17 §4b). O que ela custa é atenção humana, e
  // esse custo é limitado pelo índice único parcial da 0123: no máximo uma
  // proposta viva por contato e campo, ou seja três por contato.
  "crm_propose_contact_field",
  // `app/api/v1/ai/cases/[id]/` — exige `agent`.
  "crm_close_human_case",
  // `app/api/v1/conversations/[id]/reactivate-bot/` — POST exige `agent`.
  // A regra dura aqui NÃO é o papel: o handler recusa `actor.type === "ai_agent"`
  // com `resume_requires_person`. Proteção dita em voz alta em vez de acidente de
  // ranking — e por isso sobreviveu à troca do papel do agente para `ai_operator`,
  // que um piso de `manager` teria transformado em bloqueio por coincidência.
  "crm_resume_ai_attendance",
  // `app/api/v1/leads/[id]/lose/` — POST exige `agent`. Encerrar demanda que o
  // cliente declarou encerrada é o trabalho do dia (paridade medida na W2→base).
  "crm_close_demand",
  // `app/api/v1/leads/[id]/reactivation/` — POST exige `agent`.
  "crm_propose_reactivation",
  // `app/api/v1/conversations/[id]/assign` — exige `agent`: é a fila.
  "crm_assign_conversation",
  // `app/api/v1/conversation-tags` é leitura `viewer`; marcar conversa é trabalho
  // de atendente e o dano máximo é um filtro sujo, reversível na tela.
  "crm_manage_tags",
  // `app/api/v1/conversations/[id]/drafts/` — POST exige `agent` (auth-dual).
  // Paridade medida com a própria rota: quem integra e quem atende criam
  // rascunho com o MESMO papel. O poder concedido é o MENOR possível — a tool
  // grava uma linha que uma PESSOA precisa revisar e enviar (`consumed_at` só
  // depois do clique); ela não envia nada ao cliente, então não muda a casa.
  "crm_create_conversation_draft",
];

function alcancavelPeloAgente(requiresRole: Role): boolean {
  return ROLE_RANK[PAPEL_DO_AGENTE_PUBLICADO] >= ROLE_RANK[requiresRole];
}

describe("catálogo de tools — papel exigido e alcance real do agente", () => {
  it("tem pelo menos uma tool (guarda de vacuidade)", () => {
    // Sem isto, um catálogo vazio faria as asserções abaixo passarem por
    // ausência de dado — o falso verde mais barato que existe.
    expect(allTools.length).toBeGreaterThan(0);
  });

  it("nenhuma capacidade nasce inalcançável POR ACIDENTE", () => {
    // O que este gate caça é a restrição NÃO DECLARADA: a tool que ficou fora do
    // alcance do agente por descuido de `requiresRole` e falha em silêncio (a
    // ponte devolve o erro ao modelo, e o humano que ligou não fica sabendo).
    // Restrição deliberada se DECLARA com `apenasHumano` — e aí não é acidente.
    const acidentais = allTools
      .filter((t) => !alcancavelPeloAgente(t.requiresRole))
      .filter((t) => !catalogEntry(t.name)?.apenasHumano)
      .map((t) => t.name)
      .sort();
    expect(acidentais).toEqual([...INALCANCAVEIS_CONHECIDAS].sort());
  });

  it("capacidade marcada como operada por pessoa está mesmo fora do alcance do agente", () => {
    // A marca é declaração, não trava — quem trava é `requiresRole`. Uma tool
    // marcada `apenasHumano` mas alcançável pelo agente é a pior combinação:
    // diz na tela que só gente opera, e o agente opera assim mesmo.
    const mentirosas = allTools
      .filter((t) => catalogEntry(t.name)?.apenasHumano)
      .filter((t) => alcancavelPeloAgente(t.requiresRole))
      .map((t) => t.name);
    expect(mentirosas).toEqual([]);
  });

  it("escrita que muda a casa não entra no alcance do agente por atalho", () => {
    const frouxas = allTools
      .filter((t) => t.category === "write")
      .filter((t) => !ESCRITA_QUE_E_TRABALHO_DE_ATENDENTE.includes(t.name))
      // Piso `ai_operator`, não `manager`. Não é afrouxamento: `ai_operator`
      // vive só no escopo do token efêmero e NUNCA em `user_organizations`,
      // então nenhuma PESSOA o alcança — que é o que esta guarda protege. O
      // que muda é o agente passar a alcançar, deliberadamente.
      .filter((t) => ROLE_RANK[t.requiresRole] < ROLE_RANK.ai_operator)
      .map((t) => `${t.name} exige apenas '${t.requiresRole}'`);
    expect(frouxas).toEqual([]);
  });

  it("as duas listas não guardam nome que já saiu do catálogo", () => {
    // Sem esta guarda, uma exceção sobreviveria à tool que a justificava e
    // passaria a autorizar, em silêncio, a próxima que reusasse o nome.
    const nomes = new Set(allTools.map((t) => t.name));
    const orfas = [...ESCRITA_QUE_E_TRABALHO_DE_ATENDENTE, ...INALCANCAVEIS_CONHECIDAS].filter(
      (n) => !nomes.has(n),
    );
    expect(orfas).toEqual([]);
  });

  it("dívida declarada não esconde capacidade já consertada", () => {
    const porNome = new Map(allTools.map((t) => [t.name, t]));
    const jaResolvidas = INALCANCAVEIS_CONHECIDAS.filter((nome) => {
      const t = porNome.get(nome);
      // Tool removida do catálogo também sai da dívida — senão a lista
      // sobreviveria à própria capacidade.
      return t === undefined || alcancavelPeloAgente(t.requiresRole);
    });
    expect(jaResolvidas).toEqual([]);
  });

  /**
   * CONTROLE POSITIVO — a constante lá em cima ainda descreve o código?
   *
   * ⚠️ SEM ISTO O TESTE PASSA SOZINHO DEPOIS DE UM CONSERTO NO MINT.
   * `PAPEL_DO_AGENTE_PUBLICADO` é um literal escrito à mão: no dia em que alguém
   * fizer o token efêmero mintar `role:manager`, tudo aqui continuaria verde
   * descrevendo um mundo que deixou de existir — e as duas listas seguiriam
   * classificando capacidades por uma régua que não vale mais. Ler o fonte é feio
   * e é o único jeito de a afirmação envelhecer com barulho.
   */
  it("o mint do token efêmero ainda grava o papel que este teste assume", () => {
    const fonte = readFileSync(join(RAIZ, "lib/ai/runtime/mcp_token.ts"), "utf8");
    expect(fonte).toContain(`"role:${PAPEL_DO_AGENTE_PUBLICADO}"`);

    const runtime = readFileSync(join(RAIZ, "lib/ai/runtime/agent.ts"), "utf8");
    expect(runtime).toContain(`\`agent_run:\${run.id}\``);
    expect(runtime).toContain(`"role:${PAPEL_DO_AGENTE_PUBLICADO}"`);
  });
});
