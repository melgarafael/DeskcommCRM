import { z } from "zod";
import { audit } from "@/lib/audit";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { avisarQuePropostaPrecisaDeRevisao } from "@/lib/propostas/aviso-de-revisao";
import { buscarPadroesDaOrganizacao } from "@/lib/propostas/padroes-da-organizacao";
import {
  CATEGORIAS_DO_BRIEFING,
  categoriasFaltando,
  fraseConfere,
  rotuloDaCategoria,
} from "@/lib/propostas/briefing-universal";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { fusoDaOrganizacao, somarDiasNoFuso } from "@/lib/propostas/data-no-fuso";
import { rotuloDaVariavel } from "@/lib/propostas/documento/rotulos-das-variaveis";
import { extrairVariaveis } from "@/lib/propostas/documento/variaveis";
import { resolverItensDaProposta } from "@/lib/propostas/itens";
import { listarModelosAtivos } from "@/lib/propostas/modelos/catalogo-da-organizacao";
import { resolverModelo } from "@/lib/propostas/modelos/resolver";
import { capacidadesDaOrganizacao } from "@/lib/organizacao/capacidades";
import { DERIVACAO_TERMINADA, TIPOS_DERIVAVEIS } from "@/lib/messaging/media/derivable";
import type { Actor } from "@/lib/api/handlers/types";
import type { McpContext, McpToolDefinition } from "@/lib/mcp/types";

const itemShape = {
  product_id: z.string().uuid().nullable().optional(),
  produto_codigo: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Código do produto do catálogo — o MESMO campo que você já usa em `produto_codigo` no " +
        "send_message para mandar foto. Use quando souber o código mas não tiver o product_id. " +
        "Se os dois vierem juntos, product_id vale.",
    ),
  descricao: z.string().min(1).max(500),
  quantidade: z.number().positive().default(1),
  /**
   * Opcional e nullable: sem product_id E sem preço, o item nasce "a
   * definir" (§5.2). Com product_id, este valor é sempre ignorado — o preço
   * vem do catálogo no servidor (D5).
   */
  preco_unitario_cents: z.number().int().nonnegative().nullable().optional(),
};

const draftProposalInputShape = {
  lead_id: z
    .string()
    .uuid()
    .describe("O negócio (lead) desta conversa — vem do contexto do turno."),
  conversation_id: z
    .string()
    .uuid()
    .describe("A conversa deste turno — o envio da proposta vai usar exatamente esta conversa."),
  titulo: z
    .string()
    .min(1)
    .max(200)
    .describe("Título curto da proposta, ex.: 'Orçamento site institucional'."),
  itens: z
    .array(z.object(itemShape))
    .min(1)
    .describe(
      "Itens do que está sendo oferecido. Use product_id quando o item vier do catálogo — o " +
        "preço é resolvido pelo servidor e o que você mandar em preco_unitario_cents é ignorado. " +
        "Sem product_id e sem preco_unitario_cents, o item nasce 'a definir'.",
    ),
  template_slug_sugerido: z
    .string()
    .optional()
    .describe(
      "Se você já entendeu o tipo de projeto, sugira um modelo pelo slug. Use um slug " +
        "devolvido por crm_preparar_proposta. Uma pessoa confirma antes de valer — errar a " +
        "sugestão não é grave, mas não invente slug.",
    ),
  briefing: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "O que você entendeu da conversa até agora, para preencher o documento: nome/empresa do " +
        "cliente, objetivo do projeto, escopo (páginas, funcionalidades, integrações...), o que " +
        "está incluído e o que não está. Use as MESMAS chaves que o documento usa — ex.: " +
        '{"project":{"name":"..."},"client":{"company":"..."},"scope":{"pages_list":"Home, Sobre, Contato"},' +
        '"included":{"list":"..."},"excluded":{"list":"..."}}. Além das chaves do documento, o ' +
        "briefing EXIGE `nucleo` (as 7 categorias: objetivo, entregas, o_que_o_cliente_tem, " +
        "responsabilidades, prazo, decisao_e_orcamento, referencia — cada uma com o texto, ou " +
        '"cliente_nao_sabe" ou "nao_se_aplica") e `confirmacao` (`{ frase_do_cliente }`, a frase ' +
        "exata com que o cliente confirmou o resumo). Sem `nucleo` completo e sem `confirmacao`, " +
        "o rascunho é recusado. Preço, prazo e validade NÃO entram aqui — o sistema já sabe e " +
        "calcula sozinho.",
    ),
};

/** Ator do ctx → o que a auditoria grava. Mesmo padrão de retencao.ts/escalacao.ts. */
function actorAudit(actor: Actor): { actorUserId: string | null; metadataActor: Record<string, unknown> } {
  if (actor.type === "user") return { actorUserId: actor.id, metadataActor: { actor_type: "user" } };
  return { actorUserId: null, metadataActor: { actor_type: actor.type, actor_id: actor.id } };
}

/**
 * O PRAZO QUE O CLIENTE FALOU EM VOZ ALTA — e só quando a frase é inequívoca.
 *
 * O campo `Prazo (dias úteis)` do editor nascia vazio mesmo com a IA tendo
 * perguntado o prazo e ouvido "até 30 dias": `briefing.nucleo.prazo` é o que a
 * conversa sabe, e nada o levava até a coluna.
 *
 * A régua é estreita de propósito, e é a mesma do resto do produto: NADA é
 * inventado. Só entra número que a frase traz por extenso — "30 dias", "15
 * dias úteis". Sem número ("quando der", "cliente_nao_sabe", "nao_se_aplica")
 * fica nulo, e a pessoa preenche. Faixa "2-3 dias" também fica nula: escolher
 * um dos dois números seria chutar em campo que vai para o documento.
 *
 * O limite 1–365 é o do schema (`lib/schemas/propostas.ts` e a rota do PATCH):
 * gravar fora dele é devolver 422 na edição de um rascunho que a IA acabou de
 * criar.
 */
const NUMERO_DE_DIAS = /(?:^|[^\d\-–—~àá])\s*(\d+)\s*dias?\b/i;

function prazoEmDiasUteisDoBriefing(briefing: unknown): number | null {
  if (typeof briefing !== "object" || briefing === null) return null;
  const nucleo = (briefing as { nucleo?: unknown }).nucleo;
  if (typeof nucleo !== "object" || nucleo === null) return null;
  const prazo = (nucleo as { prazo?: unknown }).prazo;
  if (typeof prazo !== "string") return null;
  const digitos = NUMERO_DE_DIAS.exec(prazo)?.[1];
  if (digitos === undefined) return null;
  const dias = Number.parseInt(digitos, 10);
  if (!Number.isInteger(dias) || dias < 1 || dias > 365) return null;
  return dias;
}

interface MensagemDoLote {
  direction: string;
  sent_via: string;
  type: string;
  body: string | null;
  media_derived_text: string | null;
  media_derived_status: string | null;
  created_at: string;
}

/**
 * As mensagens RECEBIDAS do turno atual: as inbound que chegaram depois da
 * última mensagem enviada pela IA anterior a elas. Isto é: pega a data da
 * última outbound de IA anterior à inbound mais recente, e as inbound
 * posteriores a essa data. Um "sim" antigo, de antes da última resposta da
 * IA, não serve como confirmação.
 */
async function loteDoTurnoAtual(
  ctx: McpContext,
  conversationId: string,
): Promise<{ pendente: boolean; textos: string[] }> {
  const { data } = await ctx.supabase
    .from("messages")
    .select("direction, sent_via, type, body, media_derived_text, media_derived_status, created_at")
    .eq("organization_id", ctx.organizationId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  const recebidas = ((data ?? []) as MensagemDoLote[]).filter((m) => m.direction === "inbound");
  if (recebidas.length === 0) return { pendente: false, textos: [] };
  const maisRecente = recebidas.map((m) => m.created_at).reduce((a, b) => (a > b ? a : b));
  const cortes = ((data ?? []) as MensagemDoLote[])
    .filter((m) => m.direction === "outbound" && m.sent_via === "ai" && m.created_at < maisRecente)
    .map((m) => m.created_at);
  const corte = cortes.length > 0 ? cortes.reduce((a, b) => (a > b ? a : b)) : null;
  const lote = corte === null ? recebidas : recebidas.filter((m) => m.created_at > corte);
  const textos = lote.map((m) => (m.body?.trim() ? m.body : (m.media_derived_text ?? "")));
  // Pendente é só a mídia cuja leitura AINDA não terminou. A foto que terminou
  // sem texto (adiada por falta de leitor, contato pessoal, vídeo desligado) e
  // a figurinha deixavam o lote "pendente" para sempre, e a ferramenta mentia
  // "ainda está sendo transcrita". A frase de confirmação continua conferida
  // nos textos abaixo (`fraseConfere`).
  const pendente = lote.some(
    (m) =>
      !(m.body?.trim() || m.media_derived_text?.trim()) &&
      TIPOS_DERIVAVEIS.has(m.type) &&
      !DERIVACAO_TERMINADA.has(m.media_derived_status ?? ""),
  );
  return { pendente, textos };
}

export const crmDraftProposal: McpToolDefinition<typeof draftProposalInputShape> = {
  name: "crm_draft_proposal",
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  description:
    "Rascunha uma proposta comercial para o negócio desta conversa. NUNCA envia — só cria o " +
    "rascunho para uma pessoa revisar e enviar depois. Use quando o cliente pedir orçamento ou " +
    "proposta e você já souber o que oferecer. Um negócio só pode ter UM rascunho aberto por vez.",
  inputSchema: draftProposalInputShape,
  handler: async (input, ctx: McpContext) => {
    if (!(await capacidadesDaOrganizacao(ctx.supabase, ctx.organizationId)).includes("propostas")) {
      return { error: "Propostas estão desligadas nesta organização." };
    }
    const { data: lead, error: leadErr } = await ctx.supabase
      .from("crm_leads")
      .select("id, contact_id")
      .eq("organization_id", ctx.organizationId)
      .eq("id", input.lead_id)
      .maybeSingle();
    if (leadErr) return { error: "Não foi possível verificar o negócio agora." };
    if (!lead) return { error: "Negócio não encontrado nesta organização." };

    // §5.3 — um rascunho aberto por negócio. O índice único (migration 0402)
    // é a trava de verdade sob corrida; esta pré-checagem só dá o retorno
    // ensinável (o id do rascunho, para o modelo mandar retomar).
    const { data: rascunhoExistente } = await ctx.supabase
      .from("crm_proposals")
      .select("id")
      .eq("organization_id", ctx.organizationId)
      .eq("lead_id", input.lead_id)
      .eq("status", "rascunho")
      .maybeSingle();
    if (rascunhoExistente) {
      return {
        error: "Este negócio já tem um rascunho de proposta aberto — retome-o em vez de criar outro.",
        motivo: "rascunho_aberto_existe",
        rascunho_id: rascunhoExistente.id,
      };
    }

    // C3 (revisão) — `conversation_id` vem do argumento da ferramenta e é
    // gravado com o client service-role: sem confirmar que a conversa É do
    // contato deste negócio E desta organização, um id de outro contato (ou
    // de outra organização) gravava direto, e o envio mandava o PDF/preços
    // desta proposta no WhatsApp de um contato ERRADO — vazamento de dado
    // entre contatos, ou entre organizações.
    const { data: conversa } = await ctx.supabase
      .from("conversations")
      .select("id")
      .eq("organization_id", ctx.organizationId)
      .eq("id", input.conversation_id)
      .eq("contact_id", lead.contact_id)
      .maybeSingle();
    if (!conversa) {
      return { error: "Esta conversa não pertence ao contato deste negócio." };
    }

    // C5 — o briefing universal trava no código: sem as 7 categorias e sem a
    // frase de confirmação do cliente, nada é criado. A recusa diz o motivo
    // exato para a IA saber o que perguntar.
    const faltando = categoriasFaltando(input.briefing);
    if (faltando.length > 0) {
      return {
        error: `Faltam categorias do briefing: ${faltando.map(rotuloDaCategoria).join(", ")}. Pergunte ao cliente antes de rascunhar.`,
        motivo: "briefing_incompleto",
        faltando,
      };
    }
    const briefingObjeto = input.briefing as Record<string, unknown>;
    const confirmacao = briefingObjeto.confirmacao as Record<string, unknown> | undefined;
    const frase = confirmacao?.frase_do_cliente;
    if (typeof frase !== "string" || frase.trim().length === 0) {
      return {
        error:
          "Falta a confirmação do cliente no briefing (briefing.confirmacao.frase_do_cliente). " +
          "Mostre o resumo e peça confirmação antes de rascunhar.",
        motivo: "sem_confirmacao",
      };
    }
    const lote = await loteDoTurnoAtual(ctx, input.conversation_id);
    if (lote.pendente) {
      return {
        error: "A mensagem do cliente ainda está sendo transcrita; responda e tente no próximo turno.",
        motivo: "transcricao_pendente",
      };
    }
    if (!fraseConfere(frase, lote.textos)) {
      return {
        error:
          `Não encontrei a frase "${frase}" entre as últimas mensagens do cliente. ` +
          "Peça a confirmação ao cliente; não repita a ferramenta com a mesma frase.",
        motivo: "confirmacao_nao_encontrada",
      };
    }

    if (input.template_slug_sugerido !== undefined) {
      const ativos = await listarModelosAtivos(ctx.supabase, ctx.organizationId);
      if (!ativos.some((m) => m.slug === input.template_slug_sugerido)) {
        return {
          error: `Modelo "${input.template_slug_sugerido}" não existe nesta organização. Escolha um de modelos_validos.`,
          modelos_validos: ativos.map((m) => ({ slug: m.slug, nome: m.nome })),
        };
      }
    }

    const codigosParaResolver = [
      ...new Set(
        input.itens
          .filter((it) => !it.product_id && it.produto_codigo)
          .map((it) => it.produto_codigo!),
      ),
    ];
    const produtoIdPorCodigo = new Map<string, string>();
    if (codigosParaResolver.length > 0) {
      const { data: produtosPorCodigo } = await ctx.supabase
        .from("catalog_products")
        .select("id, codigo")
        .eq("organization_id", ctx.organizationId)
        .in("codigo", codigosParaResolver);
      for (const p of (produtosPorCodigo ?? []) as Array<{ id: string; codigo: string }>) {
        produtoIdPorCodigo.set(p.codigo, p.id);
      }
      const naoEncontrado = codigosParaResolver.find((c) => !produtoIdPorCodigo.has(c));
      if (naoEncontrado) {
        return { error: `Produto com código "${naoEncontrado}" não encontrado no catálogo desta organização.` };
      }
    }

    const itensNormalizados = input.itens.map((it, i) => ({
      product_id: it.product_id ?? (it.produto_codigo ? (produtoIdPorCodigo.get(it.produto_codigo) ?? null) : null),
      descricao: it.descricao,
      quantidade: it.quantidade,
      preco_unitario_cents: it.preco_unitario_cents ?? null,
      desconto_cents: 0,
      position: (i + 1) * 1000,
    }));
    // D11 — a proposta nasce na moeda da organização; item de catálogo em
    // moeda diferente é recusado dentro do resolvedor, nunca convertido.
    const moeda = await moedaDaOrganizacao(ctx.supabase, ctx.organizationId);
    const resolvido = await resolverItensDaProposta(ctx.supabase, ctx.organizationId, itensNormalizados, moeda);
    if (!resolvido.ok) return { error: resolvido.motivo };

    const padroes = await buscarPadroesDaOrganizacao(ctx.supabase, ctx.organizationId);
    const fuso = await fusoDaOrganizacao(ctx.supabase, ctx.organizationId);
    const validUntil = somarDiasNoFuso(new Date(), padroes.defaultValidDays, fuso);

    const agentId = ctx.actor.type === "ai_agent" ? (ctx.actor.agent_id ?? null) : null;

    const { data: proposta, error } = await ctx.supabase
      .from("crm_proposals")
      .insert({
        organization_id: ctx.organizationId,
        lead_id: lead.id,
        contact_id: lead.contact_id,
        conversation_id: input.conversation_id,
        titulo: input.titulo,
        condicoes: padroes.defaultConditions,
        valid_until: validUntil,
        // O prazo que a pessoa falou no briefing, quando a frase trazia número
        // por extenso. Sem número, nulo — a pessoa preenche no editor.
        prazo_dias_uteis: prazoEmDiasUteisDoBriefing(input.briefing),
        total_cents: resolvido.totalCents,
        pricing_status: resolvido.pricingStatus,
        moeda,
        status: "rascunho",
        drafted_by_agent_id: agentId,
        template_slug_sugerido: input.template_slug_sugerido ?? null,
        briefing_json: input.briefing ?? null,
      })
      .select("id")
      .single();
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        return { error: "Este negócio já tem um rascunho de proposta aberto.", motivo: "rascunho_aberto_existe" };
      }
      return { error: "Não foi possível criar o rascunho agora." };
    }
    if (!proposta) return { error: "Não foi possível criar o rascunho agora." };

    const { error: itensErr } = await ctx.supabase.from("crm_proposal_items").insert(
      resolvido.itens.map((it) => ({ organization_id: ctx.organizationId, proposal_id: proposta.id, ...it })),
    );
    if (itensErr) {
      // Sem isto, o rascunho ficava vazio e — depois da C3 — continuava
      // ocupando a trava de "um rascunho por negócio" (§5.3): a IA tentaria
      // de novo e receberia rascunho_aberto_existe apontando pra um rascunho
      // sem item nenhum, sem jeito óbvio de sair dali pela ferramenta.
      await ctx.supabase.from("crm_proposals").delete().eq("organization_id", ctx.organizationId).eq("id", proposta.id);
      return { error: "Não foi possível criar o rascunho agora." };
    }

    // D5 — a ferramenta hoje não emitia nada disso. Fire-and-forget: a
    // timeline/auditoria nunca derruba a criação do rascunho.
    await emitLeadActivity(ctx.supabase, {
      organizationId: ctx.organizationId,
      leadId: lead.id,
      contactId: lead.contact_id,
      type: "proposal_drafted",
      sourceModule: "proposals",
      sourceId: proposta.id,
      actor: ctx.actor,
      reason: `Rascunho de proposta criado pela IA: ${input.titulo}`,
    });

    void avisarQuePropostaPrecisaDeRevisao(ctx.supabase, ctx.organizationId, proposta.id);

    const a = actorAudit(ctx.actor);
    void audit({
      action: "proposal.drafted",
      actorUserId: a.actorUserId,
      actorApiTokenId: ctx.apiTokenId,
      organizationId: ctx.organizationId,
      resourceType: "crm_proposals",
      resourceId: proposta.id,
      requestId: ctx.requestId,
      metadata: { ...a.metadataActor, via: "mcp" },
    });

    return { proposal_id: proposta.id, total_cents: resolvido.totalCents, pricing_status: resolvido.pricingStatus };
  },
};

const prepararPropostaInputShape = {
  template_slug: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "O slug de um modelo da organização para listar os campos que ele pede, com rótulo legível. " +
        "Omita para receber só os modelos e as categorias do briefing.",
    ),
};

/**
 * O que o sistema calcula sozinho e nunca pede ao cliente: espelha
 * `montarDadosDoDocumento` (investment, schedule e commercial_terms vêm de
 * coluna gravada) mais `client.name`/`client.company_or_name` (vêm do
 * contato) e a data de aprovação (ninguém a sabe no rascunho).
 */
function variavelCalculadaPeloSistema(caminho: string): boolean {
  return (
    caminho === "client.name" ||
    caminho === "client.company_or_name" ||
    caminho === "investment" ||
    caminho.startsWith("investment.") ||
    caminho === "commercial_terms" ||
    caminho.startsWith("commercial_terms.") ||
    caminho === "approval" ||
    caminho.startsWith("approval.")
  );
}

export const crmPrepararProposta: McpToolDefinition<typeof prepararPropostaInputShape> = {
  name: "crm_preparar_proposta",
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  description:
    "Prepara o terreno da proposta: lista os modelos ativos desta organização, diz o que " +
    "perguntar ao cliente (as 7 categorias do briefing) e — com um modelo — quais campos ele " +
    "pede. Chame antes de rascunhar; nunca cria nada.",
  inputSchema: prepararPropostaInputShape,
  handler: async (input, ctx: McpContext) => {
    if (!(await capacidadesDaOrganizacao(ctx.supabase, ctx.organizationId)).includes("propostas")) {
      return { error: "Propostas estão desligadas nesta organização." };
    }
    const ativos = await listarModelosAtivos(ctx.supabase, ctx.organizationId);
    const resposta = {
      modelos: ativos.map((m) => ({ slug: m.slug, nome: m.nome, origem: m.origem })),
      categorias: CATEGORIAS_DO_BRIEFING.map((c) => ({ chave: c.chave, rotulo: c.rotulo, orientacao: c.orientacao })),
      instrucao:
        "Pergunte ao cliente, com as suas palavras e no contexto do pedido, o que faltar destas " +
        "categorias; 'cliente não sabe' e 'não se aplica' são respostas válidas. Antes de rascunhar, " +
        "mostre um resumo e peça confirmação; 'certo' com informação nova NÃO é confirmação — " +
        "ajuste o resumo e peça de novo.",
    };
    if (input.template_slug === undefined) return resposta;
    if (!ativos.some((m) => m.slug === input.template_slug)) {
      return {
        error: `Modelo "${input.template_slug}" não existe nesta organização. Escolha um de modelos_validos.`,
        modelos_validos: ativos.map((m) => ({ slug: m.slug, nome: m.nome })),
      };
    }
    const modelo = await resolverModelo(ctx.supabase, ctx.organizationId, input.template_slug);
    if (!modelo) {
      return {
        error: `Modelo "${input.template_slug}" não existe nesta organização. Escolha um de modelos_validos.`,
        modelos_validos: ativos.map((m) => ({ slug: m.slug, nome: m.nome })),
      };
    }
    const vistos = new Set<string>();
    const caminhos: string[] = [];
    for (const secao of modelo.sections) {
      for (const texto of [secao.title, secao.body]) {
        for (const caminho of extrairVariaveis(texto ?? "")) {
          if (vistos.has(caminho) || variavelCalculadaPeloSistema(caminho)) continue;
          vistos.add(caminho);
          caminhos.push(caminho);
        }
      }
    }
    return { ...resposta, campos_do_modelo: caminhos.map((caminho) => rotuloDaVariavel(caminho)) };
  },
};
