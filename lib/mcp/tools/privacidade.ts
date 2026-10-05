/**
 * Capacidades de PRIVACIDADE — LEITURA dos pedidos de titular, e só.
 *
 * DECISÃO DELIBERADA: a IA não anonimiza. A rota que anonimiza
 * (`app/api/v1/lgpd/anonymize`) exige `admin`, e pela régua da paridade a tool
 * teria de exigir o mesmo — o que a deixaria fora do alcance de qualquer agente.
 * Mas o ponto não é o papel: anonimizar é IRREVERSÍVEL por contrato do próprio
 * produto (reverter devolve 403 `lgpd_anonymization_irreversible`). Expor uma
 * tool de anonimizar, mesmo travada, só acrescenta superfície — o humano já faz
 * pela tela, que é onde a decisão deve ser tomada.
 *
 * O que a IA GANHA lendo: parar de tratar como lead ativo alguém que pediu
 * exclusão, e saber que o silêncio daquele contato tem causa. Sem isso, o
 * follow-up insiste com quem pediu para sair — que é o oposto do que a LGPD
 * pede e o pior uso possível do mecanismo anti-morte.
 */
import { z } from "zod";

import type { McpToolDefinition } from "../types";

const inputShape = {
  contact_id: z
    .string()
    .uuid()
    .optional()
    .describe("Filtra por um contato. Sem ele, devolve os pedidos abertos da organização."),
  limite: z.number().int().min(1).max(50).optional().default(20),
};

export const crmListPrivacyRequests: McpToolDefinition<typeof inputShape> = {
  name: "crm_list_privacy_requests",
  description:
    "Lista pedidos de privacidade (LGPD) da organização — exportação ou exclusão de dados — com " +
    "tipo, situação, quando chegou e o prazo. NÃO executa nada: é leitura. Use para não insistir " +
    "com quem pediu exclusão e para explicar o prazo a quem perguntar pelo próprio pedido." +
    " Em conversa de atendimento, devolve apenas os pedidos do contato desta conversa.",
  inputSchema: inputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  // LGPD nunca é bloqueada: o prazo do titular corre com a empresa suspensa.
  permiteOrgSuspensa: true,
  handler: async (input, ctx) => {
    // ── O PEDIDO DE PRIVACIDADE DE QUEM NÃO É DESTA CONVERSA (#2184) ───────
    //
    // Este é o dado mais sensível do pacote: um pedido de EXCLUSÃO aberto é o
    // que diz ao modelo "não insista com esta pessoa". Escopar ao contato do
    // turno é o que faz a resposta valer para quem está na conversa — e é,
    // também, o que impede que a abertura de um pedido de outro cliente vire
    // instrução para o lado de cá.
    //
    // É LEITURA DE LISTA, então o escopo é FILTRO (mesma regra das conversas
    // do #2182): sem `contact_id` pedido, a consulta passa a perguntar só pelo
    // contato do turno. O pedido EXPLÍCITO de outro cliente é que é recusado,
    // porque aí o modelo está perguntando por uma pessoa que não é a desta
    // conversa — mesma recusa de `crm_list_contact_orders` (#2178).
    //
    // `ctx.contatoDoTurno` é contexto de CONFIANÇA (injetado por
    // `lib/ai/runtime/tools.ts`, nunca escrito pelo modelo); sem ele — rota
    // HTTP, MCP externo, agente sem conversa — nada muda.
    const doTurno = ctx.contatoDoTurno;
    if (doTurno && input.contact_id && input.contact_id !== doTurno) {
      return {
        permitido: false,
        motivo: "fora_da_conversa",
        mensagem:
          "esta conversa é com outra pessoa — o pedido de privacidade de um cliente que não é " +
          "o desta conversa não é seu para ver; siga a conversa com quem está falando.",
      };
    }

    let q = ctx.supabase
      .from("lgpd_requests")
      .select("id, request_type, source, contact_id, status, received_at, due_at, completed_at, emergency, scope")
      .eq("organization_id", ctx.organizationId)
      .order("received_at", { ascending: false })
      .limit(input.limite);

    // O contato efetivo vai NO `WHERE`, e não num recorte depois dele: a lista
    // é paginada por `.limit`, e filtrar depois truncaria o conjunto do
    // contato como filtrar a página truncava as conversas (#2184).
    const contatoEfetivo = doTurno ?? input.contact_id;
    if (contatoEfetivo) q = q.eq("contact_id", contatoEfetivo);

    const { data, error } = await q;
    if (error) throw new Error(`listar_pedidos_de_privacidade_falhou: ${error.message}`);

    const linhas = data ?? [];
    // O modelo precisa da CONSEQUÊNCIA, não só do estado: "existe pedido de
    // exclusão aberto" tem que virar "não insista com esta pessoa".
    const exclusaoAberta = linhas.some(
      (l) => l.request_type === "redact" && l.status !== "completed" && l.status !== "rejected",
    );

    return {
      pedidos: linhas,
      ...(exclusaoAberta
        ? {
            atencao:
              "há pedido de exclusão em aberto: não envie campanha nem retorno para este contato, e não peça dados novos.",
          }
        : {}),
    };
  },
};
