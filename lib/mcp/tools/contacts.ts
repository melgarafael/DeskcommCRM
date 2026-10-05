/**
 * MCP read tools sobre /api/v1/contacts (Spec 11 §3.1).
 *
 * Wrappa os handlers REST extraidos na wave 2 (S-13.02). O MCP server core
 * injeta `ctx.supabase` (admin client + service-role) e `ctx.organizationId`
 * — handlers ja aplicam `.eq('organization_id', ctx.organization_id)` em
 * defesa-em-profundidade pos wave 3 (RLS continua valida quando ctx vem
 * de cookie).
 */
import { z } from "zod";

import {
  listContactsHandler,
  getContactHandler,
} from "@/app/api/v1/contacts/_handler";
import type { McpToolDefinition } from "../types";
import { CAMPOS_PROPONIVEIS, proporDadoDoContato } from "@/lib/contacts/proposta-de-dado";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { audit } from "@/lib/audit";

const searchInputShape = {
  query: z.string().min(1).max(200).describe("Termo de busca (nome, email ou telefone)."),
  limit: z.number().int().min(1).max(50).default(10),
  cursor: z.string().optional(),
};

export const crmSearchContacts: McpToolDefinition<typeof searchInputShape> = {
  name: "crm_search_contacts",
  description:
    "Busca contatos do CRM por nome, email ou telefone. Retorna ate 50 matches com id, nome, telefone, email, tags e timestamps. Sempre escopado a organization do token." +
    " Em conversa de atendimento, devolve apenas o contato desta conversa.",
  inputSchema: searchInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const doTurno = ctx.contatoDoTurno;
    const result = await listContactsHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      {
        search: input.query,
        limit: input.limit,
        cursor: input.cursor,
      },
      // O escopo vai NA CONSULTA, antes do limite: filtrar a página depois
      // devolvia vazio quando o contato do turno não estava entre os primeiros
      // que casavam com o termo.
      doTurno,
    );

    // ── A CONVERSA É COM ALGUÉM (#2158) ─────────────────────────────────────
    //
    // A escrita já era escopada pelo contato do turno (`negocioDaEscritaDoTurno`);
    // a LEITURA não era — e esta é a que devolve telefone E e-mail numa resposta
    // só. Num atendimento com o cliente A, o modelo buscava "Maria" e recebia a
    // ficha da cliente B: audit gravando `success: true`, e o dado saía no
    // WhatsApp do outro lado, encaminhável, sem volta. Diferente da escrita, que
    // suja um cadastro e dá para corrigir, a leitura sai do prédio.
    //
    // ESCOPO, e não tradução: o termo continua sendo o que o modelo digitou, e
    // continua sendo o `listContactsHandler` que decide o que casa — muda só
    // QUEM a resposta alcança, e quem alcança é o contato desta conversa. É o
    // propósito declarado da ferramenta ("saber com quem está falando"), que o
    // runtime já sabe sem perguntar.
    //
    // `ctx.contatoDoTurno` é contexto de CONFIANÇA: nasce no runtime e é
    // injetado em `lib/ai/runtime/tools.ts` — o modelo não escreve esse campo.
    // Sem ele (rota HTTP, MCP externo, agente sem conversa), a busca segue
    // alcançando a base da organização, exatamente como antes. O Operador TEM
    // contato do turno (`operator-turn.ts` passa `job.contact_id`) e também
    // fica escopado — o lado seguro, porque ele não fala com o lead.
    //
    // A paginação morre junto: `cursor`/`has_more` descrevem a varredura da
    // ORGANIZAÇÃO, e a próxima página voltaria a ser varredura.
    const visiveis = doTurno ? result.contacts.filter((c) => c.id === doTurno) : result.contacts;

    return {
      contacts: visiveis.map((c) => ({
        id: c.id,
        name: nomeDoContato(c),
        phone: c.phone_number,
        email: c.email,
        tags: c.tags ?? [],
        is_blocked: c.is_blocked,
        is_anonymized: c.is_anonymized,
        created_at: c.created_at,
        last_activity_at: c.last_activity_at,
      })),
      cursor: doTurno ? null : result.cursor,
      has_more: doTurno ? false : result.has_more,
    };
  },
};

const getInputShape = {
  contact_id: z.string().uuid().describe("UUID do contato."),
};

export const crmGetContact: McpToolDefinition<typeof getInputShape> = {
  name: "crm_get_contact",
  description:
    "Retorna detalhes de um contato pelo UUID. Inclui tags, consent, source. CPF nunca retornado em plaintext via MCP (sempre mascarado)." +
    " Em conversa de atendimento, devolve a ficha do contato desta conversa.",
  inputSchema: getInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    // ── A FICHA DE QUEM NÃO É DESTA CONVERSA NÃO ABRE AQUI (#2158) ──────────
    //
    // RECUSA, e não tradução: trocar o uuid pedido pelo do contato do turno
    // faria o modelo perguntar por um cliente e receber outro — a mesma razão
    // que `lib/ai/runtime/tools.ts` escreve para não trocar `lead_id` em
    // leitura. Escopar aqui seria trocar, e o pedido é de ficha, não de busca.
    //
    // O motivo vem em TEXTO, na mesma forma que `negocioDaEscritaDoTurno`
    // devolve ao modelo, para ele ler por que foi recusado e seguir a conversa
    // sem gastar turno numa exceção. `ctx.contatoDoTurno` é contexto de
    // CONFIANÇA (injetado pelo runtime, nunca escrito pelo modelo); sem ele —
    // rota HTTP, MCP externo, agente sem conversa — a ficha de qualquer
    // contato da organização segue abrindo como antes. O Operador recebe o
    // contato do turno e também é recusado aqui.
    if (ctx.contatoDoTurno && input.contact_id !== ctx.contatoDoTurno) {
      return {
        permitido: false,
        motivo: "fora_da_conversa",
        mensagem:
          "esta conversa é com outra pessoa — a ficha de um cliente que não é o desta conversa " +
          "não é sua para abrir; siga a conversa com quem está falando.",
      };
    }
    const contact = await getContactHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      { contactId: input.contact_id, decryptPurpose: null },
    );
    return {
      id: contact.id,
      name: contact.name,
      display_name: contact.display_name,
      email: contact.email,
      phone: contact.phone_number,
      tags: contact.tags ?? [],
      source: contact.source,
      consent: contact.consent ?? {},
      is_blocked: contact.is_blocked,
      is_anonymized: contact.is_anonymized,
      cpf_available: contact.cpf_available,
      created_at: contact.created_at,
      last_activity_at: contact.last_activity_at,
    };
  },
};

// ---------------------------------------------------------------------------
// crm_propose_contact_field — o dado que o cliente disse, PROPOSTO
// ---------------------------------------------------------------------------

const propostaShape = {
  contact_id: z.string().uuid(),
  campo: z
    .enum(CAMPOS_PROPONIVEIS)
    .describe("Qual informação: email, name, phone_number ou birthdate (AAAA-MM-DD)."),
  valor: z.string().min(1).max(200).describe("O valor exatamente como a pessoa informou."),
  trecho: z
    .string()
    .max(500)
    .optional()
    .describe("O que a pessoa escreveu, para quem for confirmar poder conferir."),
};

/**
 * ⚠️ Esta ferramenta NÃO grava o dado. Ela cria uma proposta que uma pessoa
 * confirma — e o `description` diz isso ao modelo em primeiro lugar, de
 * propósito: um modelo que acredite ter gravado responderia "pronto, já
 * atualizei seu cadastro" ao cliente, prometendo o que não aconteceu.
 *
 * Ela é de CATÁLOGO, e não nativa do Operador, porque o Operador não monta
 * ToolSet nativo nenhum (zero ocorrências de `tool(` em operator-turn.ts) e só
 * chama o modelo quando há MCP. Uma nativa não apareceria na tela que liga
 * capacidades, não entraria no audit `mcp.tool_called` e sumiria da telemetria
 * de uso — nasceria invisível ao invariante 3 do sistema vivo.
 */
export const crmProposeContactField: McpToolDefinition<typeof propostaShape> = {
  name: "crm_propose_contact_field",
  description:
    "Registra uma informação que o cliente forneceu (email, nome, telefone ou data de nascimento) como PROPOSTA para " +
    "uma pessoa confirmar. NADA é gravado no cadastro por conta desta chamada, e a proposta vence " +
    "sozinha se ninguém decidir. Nunca diga ao cliente que o cadastro foi atualizado. Recusa se já " +
    "houver proposta do mesmo campo aguardando decisão, se o valor for igual ao que já está " +
    "gravado, ou se o contato foi anonimizado.",
  inputSchema: propostaShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const r = await proporDadoDoContato(ctx.supabase, {
      organizationId: ctx.organizationId,
      contactId: input.contact_id,
      campo: input.campo,
      valor: input.valor,
      trecho: input.trecho ?? null,
    });

    if (!r.criada) {
      // As mensagens são para o MODELO decidir o que fazer em seguida — e
      // nenhuma delas é para repetir ao cliente. Falam do fluxo interno, não do
      // atendimento.
      const explicacao: Record<string, string> = {
        contato_nao_encontrado: "não encontrei esse contato nesta conta.",
        contato_anonimizado:
          "esse contato exerceu o direito de exclusão de dados; não é possível registrar informações dele.",
        valor_invalido:
          "o valor não tem forma de email/telefone/nome/data de nascimento válidos — confirme com a pessoa.",
        valor_igual_ao_atual: "essa informação já está no cadastro; não há o que confirmar.",
        ja_existe_proposta:
          "já existe uma proposta desse mesmo campo aguardando decisão de uma pessoa — não crie outra.",
        erro: "não consegui registrar a proposta agora.",
      };
      return { proposta_criada: false, motivo: r.motivo, mensagem: explicacao[r.motivo] };
    }

    // Mesmo payload de ator das outras tools de escrita. Inline porque
    // `retencao.ts` mantém o dele local — extrair para um módulo comum tocaria
    // um arquivo alheio sem que este trabalho peça isso.
    const a =
      ctx.actor.type === "user"
        ? { actorUserId: ctx.actor.id as string | null, metadataActor: { actor_type: "user" } }
        : { actorUserId: null, metadataActor: { actor_type: ctx.actor.type, actor_id: ctx.actor.id } };
    await audit({
      action: "contact.field_proposed",
      actorUserId: a.actorUserId,
      organizationId: ctx.organizationId,
      resourceType: "contact",
      resourceId: input.contact_id,
      requestId: ctx.requestId,
      // O par antes/depois desde a PROPOSTA, mesma grafia de `team.role_changed`.
      // A proposta é uma intenção auditável mesmo que nunca vire escrita.
      metadata: {
        ...a.metadataActor,
        proposal_id: r.id,
        campo: input.campo,
        old_value: r.valorAnterior,
        new_value: input.valor,
      },
    });

    return {
      proposta_criada: true,
      proposta_id: r.id,
      campo: input.campo,
      aguardando: "confirmação de uma pessoa",
    };
  },
};
