/**
 * Schemas Zod do EPIC-03 Inbox + Messaging.
 *
 * Cobre boundary de validação das rotas /api/v1/conversations e
 * /api/v1/messages. Validações compartilhadas entre rota REST e webhooks
 * (quando o payload entra na pipeline pós-verificação HMAC).
 */
import { z } from "zod";
import { COMANDOS_DO_BANCO, type ComandoDoBanco } from "@/lib/inbox/comando-da-conversa";
import { PISO_DA_BUSCA, buscaValeConsulta } from "@/lib/inbox/termo-de-busca";

/**
 * O que a API aceita ESCREVER. Cinco valores, e a ausência de `pending`/`resolved`
 * é deliberada: quem escreve esses dois é o MOTOR (`performHumanHandoff` grava
 * `pending` ao escalar), e deixar um cliente REST gravá-los seria deixá-lo fingir
 * uma escalação que nunca aconteceu.
 */
export const conversationStatusSchema = z.enum([
  "open",
  "claimed",
  "ai_handling",
  "closed",
  "archived",
]);

/**
 * O que a API aceita FILTRAR. Sete — o vocabulário inteiro do CHECK do banco.
 *
 * Ler e escrever são perguntas diferentes, e tratá-las como uma só deixava
 * `pending` — o estado da conversa que o automático escalou — inalcançável por
 * qualquer filtro da API. Não havia como pedir "as conversas que a IA passou para
 * uma pessoa e ninguém pegou", que é a pergunta mais urgente do inbox.
 */
export const conversationStatusFiltroSchema = z.enum([
  "open",
  "pending",
  "resolved",
  "claimed",
  "ai_handling",
  "closed",
  "archived",
]);

export const messageDirectionSchema = z.enum(["inbound", "outbound"]);

export const messageTypeSchema = z.enum([
  "text",
  "image",
  "audio",
  "document",
  "sticker",
  "video",
  "location",
  "contact",
  // Envio de template aprovado (canal oficial, fora da janela de 24h). Não é
  // "texto com outro nome": o tipo é o que carrega custo, conformidade de janela e
  // o que o contato de fato viu (cabeçalho, rodapé, botões).
  "template",
]);

export const messageStatusSchema = z.enum([
  "queued",
  "sending",
  "sent",
  "delivered",
  "read",
  "failed",
]);

export const sendMessageSchema = z
  .object({
    conversation_id: z.string().uuid(),
    type: messageTypeSchema.default("text"),
    body: z.string().min(1).max(4096).optional(),
    media_url: z.string().url().optional(),
    media_storage_path: z.string().min(1).max(500).optional(),
    media_mime: z.string().optional(),
    media_size_bytes: z.number().int().positive().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    /** Só em `type: "template"`. Nome exato aprovado na Meta. */
    template_name: z.string().min(1).max(512).optional(),
    /** Só em `type: "template"`. `pt_BR` e `pt` são templates DISTINTOS. */
    template_language: z.string().min(2).max(16).optional(),
    /**
     * Só em `type: "template"`. Valor por slot, chaveado por `slotKey`
     * (`lib/channels/meta/build-components.ts`) — a MESMA função que o formulário
     * da tela usa. Chave montada de outro jeito é o mismatch voltando.
     */
    template_values: z.record(z.string(), z.string()).optional(),
    /**
     * A mensagem que esta responde — o id da NOSSA linha, não o do provider.
     *
     * Quem envia conhece o que está na tela, e na tela está o nosso id. A
     * tradução para o id que a plataforma entende (`wamid`) é feita no handler,
     * lendo a linha apontada: pedir o `wamid` aqui obrigaria a tela a conhecer
     * o vocabulário do canal, que é justamente o que o seam existe para evitar.
     */
    reply_to_message_id: z.string().uuid().optional(),
  })
  .refine(
    (d) => {
      if (d.type === "contact") {
        const id = d.metadata?.shared_contact_id;
        if (typeof id === "string" && id.length > 0) return true;
        const sc = d.metadata?.shared_contact;
        if (sc && typeof sc === "object" && !Array.isArray(sc)) {
          const phone = (sc as Record<string, unknown>).phone_number;
          return typeof phone === "string" && phone.trim().length >= 8;
        }
        return false;
      }
      return !!d.body || !!d.media_url || !!d.media_storage_path;
    },
    {
      message:
        "body, media_url, media_storage_path, metadata.shared_contact_id or metadata.shared_contact.phone_number required",
      path: ["body"],
    },
  );

export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const claimConversationSchema = z.object({
  expected_assignee: z.string().uuid().nullable().optional(),
});

export type ClaimConversationInput = z.infer<typeof claimConversationSchema>;

/** G3-01: transferência imediata (decisão G1-06d) — reatribui com motivo opcional. */
export const transferConversationSchema = z.object({
  to_user_id: z.string().uuid(),
  reason: z.string().trim().min(1).max(500).optional(),
});

export type TransferConversationInput = z.infer<typeof transferConversationSchema>;

export const updateConversationStatusSchema = z.object({
  status: conversationStatusSchema,
});

export type UpdateConversationStatusInput = z.infer<typeof updateConversationStatusSchema>;

/**
 * G3-05: normalização reutilizável de tag (mesmo shape de contacts.tags /
 * crm_leads.tags — text[]). trim + lowercase; 1..40 chars por tag.
 */
export const conversationTagSchema = z.string().trim().toLowerCase().min(1).max(40);

/** ≤20 tags, deduplicadas após normalização. */
export const conversationTagsSchema = z
  .array(conversationTagSchema)
  .max(20)
  .transform((tags) => Array.from(new Set(tags)));

export type ConversationTags = z.infer<typeof conversationTagsSchema>;

/** G3-05: PATCH /conversations/[id] aceita status e/ou tags (ao menos um). */
export const patchConversationSchema = z
  .object({
    status: conversationStatusSchema.optional(),
    expected_revision: z.number().int().positive().optional(),
    tags: conversationTagsSchema.optional(),
  })
  .refine((d) => d.status !== undefined || d.tags !== undefined, {
    message: "Informe status ou tags.",
  });

export type PatchConversationInput = z.infer<typeof patchConversationSchema>;

/** POST /conversations/open-with-contact — abrir inbox a partir de cartão de contato. */
export const openConversationWithContactSchema = z
  .object({
    channel_session_id: z.string().uuid().optional(),
    contact_id: z.string().uuid().optional(),
    phone_number: z.string().min(8).max(32).optional(),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .refine((d) => !!d.contact_id || !!d.phone_number?.trim(), {
    message: "Informe contact_id ou phone_number.",
  });

export type OpenConversationWithContactInput = z.infer<typeof openConversationWithContactSchema>;

/**
 * Estados TERMINAIS: atendimento encerrado; nova entrada válida pode reabrir.
 *
 * Vive aqui, e não espalhado em cada `.not(...)`, porque "acabou" é uma decisão
 * de produto — se um dia `resolved` deixar de ser legado e passar a valer, o
 * lugar de dizer isso é um só.
 */
export const CONVERSATION_TERMINAL_STATUSES = ["closed", "archived"] as const;

/**
 * OS STATUS EM QUE UMA CONVERSA SEM DONO ESTÁ ESPERANDO UMA PESSOA.
 *
 * Existe pela MESMA razão do irmão acima — "está na fila" é decisão de produto e
 * precisa de um lugar só — e nasce de uma divergência medida: a definição estava
 * copiada em CINCO sítios e eles não concordavam entre si.
 *
 *   `supabase/baseline.sql` (trg_conversation_routing_requested)  open+pending
 *   `lib/routing/queue.ts` getQueuePosition  (o nº que o CLIENTE ouve)  open+pending
 *   `lib/routing/queue.ts` getQueuePositions (o nº que a TELA mostra)   open
 *   `lib/routing/queue.ts` getQueueStatus    (o painel do gerente)      open
 *   `app/api/v1/conversations/counts`        (o badge da aba)           open
 *   `components/inbox/InboxLayout` tabToFilter (a aba Fila)             open
 *
 * Duas consequências, as duas do produto e não de estilo:
 *
 *   1. A conversa que o automático ESCALOU fica em `status='pending'`
 *      (`performHumanHandoff`), então ela sumia da aba Fila, do badge e do painel
 *      do gerente — exatamente a conversa que mais precisa de uma pessoa era a
 *      única invisível. O trigger de roteamento, esse, sempre a enfileirou: é por
 *      isso que o rodízio a atribuía enquanto a tela jurava que ela não existia.
 *   2. Duas funções VIZINHAS no mesmo arquivo davam números diferentes: o "você é
 *      o 5º da fila" que o cliente recebe pelo WhatsApp contava `pending`, e o
 *      "3º" que o atendente lê na tela não. A promessa feita ao cliente e o que a
 *      equipe via eram calculados por réguas diferentes.
 *
 * `claimed` não entra (tem dono), `ai_handling` não entra (o automático está
 * cuidando — é a aba IA), terminais não entram.
 */
export const CONVERSATION_QUEUE_STATUSES = ["open", "pending"] as const;

export const listConversationsQuerySchema = z.object({
  /**
   * Um status, ou vários separados por vírgula (`?status=open,pending`).
   *
   * ADITIVO: `?status=open` continua valendo e continua devolvendo o mesmo — a
   * saída é sempre normalizada para lista, e uma lista de um elemento produz o
   * mesmo SQL que a igualdade produzia. A forma plural existe porque a aba Fila
   * precisa de DOIS estados (ver `CONVERSATION_QUEUE_STATUSES`) e, sem ela, a
   * única saída seria a tela filtrar em memória o que a página já truncou.
   */
  status: z
    .union([conversationStatusFiltroSchema, z.string()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      const itens = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const validos: Array<z.infer<typeof conversationStatusFiltroSchema>> = [];
      for (const item of itens) {
        const r = conversationStatusFiltroSchema.safeParse(item);
        if (!r.success) {
          // Recusa em vez de ignorar: filtro com valor desconhecido devolveria
          // uma lista MENOR sem nada dizendo por quê — e uma lista curta parece
          // resposta, não erro.
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `status inválido: ${item}`,
          });
          return z.NEVER;
        }
        validos.push(r.data);
      }
      return validos.length > 0 ? validos : undefined;
    }),
  /**
   * QUEM MANDA na conversa — um valor, ou vários separados por vírgula.
   *
   * É o filtro que as abas passaram a usar no lugar de `status`. A diferença não
   * é de forma, é de pergunta: `status` é ciclo de vida ("aberta? fechada?"),
   * `comando` é quem responde a próxima mensagem — e o motor de IA nunca lê
   * `status`. Enquanto as abas perguntavam pelo status, a Fila listava como
   * "aguardando atendente" as conversas que o robô estava atendendo.
   *
   * O valor é calculado pelo banco (`comando_da_conversa`, migration 0203), e é
   * por isso que ele pode ir no `WHERE` sem quebrar o cursor de paginação.
   */
  comando: z
    .union([z.enum(COMANDOS_DO_BANCO), z.string()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      const itens = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (itens.length === 0) {
        // AQUI ELE DIVERGE DO `status`, DE PROPÓSITO. Lá, lista vazia vira
        // `undefined` — "sem filtro". Aqui isso seria a pior saída possível: a
        // aba pediria um conjunto vazio e receberia TUDO, ou seja, a tela
        // afirmaria que todas as conversas estão no estado que ela nomeia.
        // Melhor um 422 barulhento que uma lista plausível e errada.
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "comando vazio" });
        return z.NEVER;
      }
      const validos: ComandoDoBanco[] = [];
      for (const item of itens) {
        const r = z.enum(COMANDOS_DO_BANCO).safeParse(item);
        if (!r.success) {
          // Mesma razão do `status`: recusar, não ignorar. Uma lista menor sem
          // explicação parece resposta.
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `comando inválido: ${item}`,
          });
          return z.NEVER;
        }
        validos.push(r.data);
      }
      return validos;
    }),
  /**
   * Esconde as conversas terminais (fechada/arquivada).
   *
   * Existe porque "Minhas" filtrava SÓ por dono e `Fechar` não solta o dono
   * (de propósito: quem atendeu é histórico que vale). Sem isto, tudo que o
   * atendente já fechou ficava na aba dele para sempre, e ela deixava de
   * significar "meu trabalho" para virar "tudo que já toquei".
   */
  exclude_finished: z.boolean().optional(),
  assigned_to: z.union([z.string().uuid(), z.literal("me"), z.literal("unassigned")]).optional(),
  channel_session_id: z.string().uuid().optional(),
  tag: conversationTagSchema.optional(),
  /**
   * Só as que têm mensagem não lida para o dono.
   *
   * NASCEU FORA DO CONTRATO E POR ISSO FORA DE TODO MECANISMO. Era `onlyUnread`,
   * um predicado aplicado em memória sobre a página JÁ TRUNCADA (50 linhas): com
   * as 50 primeiras lidas, a tela dizia "Sem conversas por aqui" — e o botão
   * "Carregar mais" nem era desenhado, porque o estado vazio retornava antes dele.
   * Medido na tela: ligar o filtro não gerava requisição nenhuma.
   *
   * Estando aqui, `tests/unit/rota-le-todo-filtro-do-schema.test.ts` passa a
   * cobrá-lo sozinho — a cerca deriva as chaves deste schema.
   */
  unread: z.coerce.boolean().optional(),
  /**
   * O termo de busca. A régua inteira vive em `lib/inbox/termo-de-busca.ts`, e a
   * tela lê a MESMA — repetir aqui faria os dois divergirem, e a divergência
   * apareceria como erro na cara de quem digita (a rota recusa e o hook mostra).
   *
   * `buscaValeConsulta` mede o termo DEPOIS de normalizado, e não o cru: um termo
   * feito só de pontuação passa por qualquer piso de caracteres e vira string
   * vazia na normalização — e vazio no `ilike` casa TUDO.
   */
  search: z
    .string()
    .trim()
    .refine(buscaValeConsulta, {
      message: `A busca precisa de pelo menos ${PISO_DA_BUSCA} caracteres.`,
    })
    .optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

export const listMessagesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
