/**
 * Schemas Zod do EPIC-03 Inbox + Messaging.
 *
 * Cobre boundary de validação das rotas /api/v1/conversations e
 * /api/v1/messages. Validações compartilhadas entre rota REST e webhooks
 * (quando o payload entra na pipeline pós-verificação HMAC).
 */
import { z } from "zod";
import { COMANDOS_DO_BANCO, type ComandoDoBanco } from "@/lib/inbox/comando-da-conversa";
import {
  MAXIMO_DE_ETIQUETAS_NO_FILTRO,
  MODOS_DE_ETIQUETA,
} from "@/lib/inbox/marcador-da-conversa";
import { PISO_DA_BUSCA, buscaValeConsulta } from "@/lib/inbox/termo-de-busca";
import { NOME_DE_ARQUIVO_MAX } from "@/lib/messaging/media/nome-de-arquivo";

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

/**
 * Os CAMPOS do envio, uma vez só.
 *
 * Existe separado do `.refine` porque a porta por telefone (#4513) precisa dos
 * MESMOS campos com um identificador diferente — o `conversation_id` deixa de
 * ser obrigatório e o telefone entra no lugar dele. Copiar o objeto seria
 * copiar o contrato: dois lugares para o mesmo `type`, os mesmos tetos de mídia
 * e o mesmo `on_behalf_of_user_id` divergindo na primeira mudança.
 */
const camposDoEnvio = z.object({
  conversation_id: z.string().uuid(),
  type: messageTypeSchema.default("text"),
  body: z.string().min(1).max(4096).optional(),
  media_url: z.string().url().optional(),
  media_storage_path: z.string().min(1).max(500).optional(),
  /**
   * O nome ORIGINAL do anexo (#4457) — o que a pessoa escolheu no seletor.
   *
   * `media_storage_path` é `out-<uuid>.<ext>` e não tem nome legível; é este
   * campo que viaja como `filename` do documento e fica gravado na linha para
   * o balão e o download mostrarem o mesmo nome. Opcional de propósito: quem
   * chama a API só com o storage_path (token) continua no basename, como antes.
   *
   * O mesmo campo nomeia o documento enviado por `media_url` (#4524): sem ele,
   * o nome sai de `metadata.media_filename`, depois do último segmento da URL
   * com extensão, e por fim de uma reserva legível pelo MIME — nunca `file`.
   */
  media_filename: z.string().min(1).max(NOME_DE_ARQUIVO_MAX).optional(),
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
  /**
   * Quem DECIDIU este envio, quando quem aperta é um token (#1613).
   *
   * O token é da organização, não de uma pessoa: sem este campo, a conversa
   * perde que foi Fulano — do ERP, da agenda, do sistema de cobrança — que
   * mandou a mensagem. O campo só CHEGA até o insert se a rota o validar
   * (escopo `messages:on_behalf` no token + membro ativo desta org com papel
   * de atendente ou acima): quem valida é a rota, porque o escopo mora na
   * linha do token e o membership, no banco.
   */
  on_behalf_of_user_id: z.string().uuid().optional(),
});

/**
 * O que a mensagem leva — o mesmo para os dois identificadores.
 *
 * Estrutural de propósito, e não `z.infer<typeof camposDoEnvio>`: os dois
 * schemas diferem no IDENTIFICADOR (o `conversation_id` é obrigatório num e
 * opcional no outro), e a regra do conteúdo não tem nada a ver com ele. Tipar
 * pelo objeto inteiro amarraria a regra ao `conversation_id` obrigatório e
 * faria o schema por telefone recusar a própria função.
 */
type ConteudoDoEnvio = {
  type: z.infer<typeof messageTypeSchema>;
  body?: string | undefined;
  media_url?: string | undefined;
  media_storage_path?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

/**
 * A mensagem precisa levar ALGUMA coisa: texto, mídia ou o cartão de contato
 * compartilhado. Vale igual para o envio por conversa e para o envio por
 * telefone — o identificador não muda o que a mensagem é.
 */
function conteudoObrigatorio(d: ConteudoDoEnvio): boolean {
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
}

export const sendMessageSchema = camposDoEnvio.refine(conteudoObrigatorio, {
  message:
    "body, media_url, media_storage_path, metadata.shared_contact_id or metadata.shared_contact.phone_number required",
  path: ["body"],
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/**
 * O corpo da rota de envio aceita UM DOS DOIS identificadores (#4513).
 *
 * ─── Por que uma porta, e não uma rota nova ─────────────────────────────────
 *
 * O conector do DeskVoice manda telefone; a rota exigia `conversation_id`. A
 * resolução de telefone já existe (`openSharedContactConversation` →
 * `encontrarContatoPorTelefone` + `fn_upsert_wa_contact`), então o que faltava
 * era a PORTA — não uma segunda regra de abertura de conversa. Uma rota irmã
 * (`/messages/by-phone`) custaria um handler a mais, um caminho a manter e um
 * `Idempotency-Key` a acertar em dobro; aqui a chave, o teto e o freio são os
 * mesmos de sempre.
 *
 * ─── O contrato antigo não muda ────────────────────────────────────────────
 *
 * `sendMessageSchema` continua com `conversation_id` OBRIGATÓRIO e continua
 * sendo o que a rota entrega ao handler. Quem já manda `conversation_id` não
 * ganha campo novo, default novo nem chave nova no corpo validado — e é por
 * isso que o hash da idempotência de quem já integra não muda de valor (o
 * `phone_number` só existe no corpo de quem escolheu o caminho novo).
 *
 * ─── Os dois juntos são AMBIGUIDADE, não "o id vence" ──────────────────────
 *
 * Aqui o schema só exige que UM venha. Quem recusa a ambiguidade é a rota
 * (`ambiguous_target`, 422), porque é ela que escolhe os identificadores — e
 * escolher por conta própria é escolher errado em silêncio: mandar o telefone
 * achando que está mandando para a conversa X é o tipo de engano que só
 * aparece na caixa de entrada do cliente.
 */
export const sendMessagePorTelefoneSchema = camposDoEnvio
  .extend({
    conversation_id: z.string().uuid().optional(),
    /**
     * O número como o conector o tem (E.164 com `+`, ou só dígitos). Quem
     * canoniza é a busca que já existe (`canonicalPhoneBR`) — este campo não
     * normaliza nada, para o corpo validado continuar sendo o que chegou.
     */
    phone_number: z.string().min(8).max(32).optional(),
  })
  .refine(conteudoObrigatorio, {
    message:
      "body, media_url, media_storage_path, metadata.shared_contact_id or metadata.shared_contact.phone_number required",
    path: ["body"],
  })
  .refine((d) => !!d.conversation_id || !!d.phone_number?.trim(), {
    message: "Informe conversation_id ou phone_number.",
    path: ["phone_number"],
  });

export type SendMessagePorTelefoneInput = z.infer<typeof sendMessagePorTelefoneSchema>;

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

/**
 * POST /api/v1/conversations/bulk (#2484, fatia F1) — ações em lote na Inbox.
 *
 * UMA rota para todas as ações, discriminada por `action` (o mesmo desenho do
 * `bulkLeadActionSchema`). O lote NÃO tem permissão própria, org própria nem
 * auditoria própria: cada id é encaminhado ao MESMO handler da conversa
 * individual (`POST [id]/close`, `PATCH [id]`, `POST [id]/transfer`,
 * `POST [id]/mark-read`, `POST [id]/pause-ai`, `POST [id]/reactivate-bot`), e
 * é ele que resolve role, organização da SESSÃO e auditoria — por item. A
 * organização portanto NUNCA vem do corpo: o schema não tem campo para ela.
 *
 * O teto de ids é política da ROTA (`TETO_DO_LOTE`), não do schema: quem
 * estoura recebe 422 `bulk_too_large` com o número na mensagem, e não um
 * `validation_error` genérico.
 */
export const bulkConversationActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("close"),
    ids: z.array(z.string().uuid()).min(1),
  }),
  z.object({
    action: z.literal("archive"),
    ids: z.array(z.string().uuid()).min(1),
  }),
  z.object({
    action: z.literal("mark-read"),
    ids: z.array(z.string().uuid()).min(1),
  }),
  z.object({
    action: z.literal("pause-ai"),
    ids: z.array(z.string().uuid()).min(1),
  }),
  z.object({
    action: z.literal("reactivate-bot"),
    ids: z.array(z.string().uuid()).min(1),
  }),
  z.object({
    action: z.literal("transfer"),
    ids: z.array(z.string().uuid()).min(1),
    // Mesmo contrato do `transferConversationSchema` — o destino é membro
    // agent+ da org da sessão, validado pelo handler da conversa.
    to_user_id: z.string().uuid(),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
]);

export type BulkConversationActionInput = z.infer<typeof bulkConversationActionSchema>;

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
  /**
   * Só as conversas encerradas a partir deste instante (`service_closed_at`).
   * A ordem da lista é por última mensagem: sem o recorte no banco, a conversa
   * fechada hoje com mensagem antiga ficaria fora dos 100 do Painel de atendimento.
   */
  closed_since: z.string().datetime().optional(),
  assigned_to: z.union([z.string().uuid(), z.literal("me"), z.literal("unassigned")]).optional(),
  channel_session_id: z.string().uuid().optional(),
  /**
   * A FILA (#3876, fatia F3): só as conversas classificadas neste setor.
   *
   * É o par de leitura do `PUT /conversations/[id]/sector` que já existia e não
   * tinha consumidor — sem ele, o seletor de fila do Inbox seria um controle que
   * muda de valor e não muda a lista. Uuid e não nome: é a chave da tabela, e um
   * nome repetido (ou renomeado) passaria a filtrar outra fila em silêncio.
   *
   * Ausente = sem filtro, como todos os auxiliares. `null` NÃO significa "sem
   * fila": nenhum cliente manda isso, e a tela que quisesse as conversas sem
   * classificação teria de pedir isso explicitamente numa fatia própria.
   */
  sector_id: z.string().uuid().optional(),
  /**
   * O MARCADOR, e agora VÁRIOS (#1274).
   *
   * Aceita `string` OU `string[]`, e a repetição na URL (`?tag=vip&tag=orçamento`)
   * é lida por `getAll`. Aceitar as DUAS formas é o que mantém o `?tag=vip`
   * singular funcionando byte a byte: `get` devolve string e `getAll` devolve
   * array de um, e os dois precisam passar pelo MESMO schema — se este só
   * aceitasse array, toda chamada antiga de API quebraria com 422.
   *
   * A lista é normalizada (trim/lowercase) item a item, pela MESMA razão de
   * `conversationTagSchema` normalizar: o `?tag=VIP` tem de achar o que foi
   * gravado como `vip` (issue #1224). Teto de 20, o mesmo da escrita.
   */
  tag: z
    .union([conversationTagSchema, z.array(conversationTagSchema).max(MAXIMO_DE_ETIQUETAS_NO_FILTRO)])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const lista = Array.isArray(v) ? v : [v];
      // Lista VAZIA vira `undefined`, e não `[]`. O `getAll` devolve `[]` numa
      // URL sem o parâmetro, e `[]` dentro de um `cs` é um filtro que NÃO CASA
      // NADA: a tela responderia "nenhuma conversa" com o filtro desligado, sem
      // erro nenhum. `undefined` é o que "sem filtro" significa.
      return lista.length > 0 ? lista : undefined;
    }),
  /**
   * E ou OU entre as etiquetas escolhidas (#1274). `e` é o padrão, e é o que
   * uma etiqueta só já significava — logo, o parâmetro só importa havendo duas.
   *
   * `z.enum` RECUSA o valor fora dos dois, e a recusa vira 422. Aqui a escolha é
   * deliberada — o inverso do `status`/`comando`, que transformam lista vazia em
   * `undefined`: `?modo=xou` é quase sempre alguém copiando o nome do parâmetro
   * errado, e responder 422 ensina o integrador a corrigir. Na TELA quem chama
   * é `modoDeEtiqueta`, que devolve `undefined` e cai no `e` — uma tela não pode
   * quebrar por um parâmetro inventado.
   */
  modo: z.enum(MODOS_DE_ETIQUETA).optional(),
  /**
   * A aba "Grupos" do inbox (Task 10). `"true"`/`"false"` como STRING — vem de
   * `searchParams`, que só conhece texto — e não `z.coerce.boolean()`, que
   * transformaria QUALQUER string não-vazia (inclusive `"false"`) em `true`.
   * Ausente = sem filtro, a lista mostra tudo, como hoje; presente decide o
   * `.eq("is_group", …)` no handler.
   */
  is_group: z.enum(["true", "false"]).optional(),
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
  /**
   * Só as conversas DESTE contato — e o filtro é do BANCO, não da página (#2184).
   *
   * `crm_list_conversations` vinha filtrando o contato em memória, sobre a
   * página que o handler já tinha truncado (10 por padrão, até 50): o
   * `has_more: false` que saía junto dizia ao agente que não havia mais nada,
   * e uma conversa MAIS ANTIGA do mesmo cliente, fora daquela página, ficava
   * inalcançável. O filtro por `input.contact_id` tinha o mesmo defeito — só
   * que mantinha o cursor, o que é pior: o cursor seguia descrevendo a
   * varredura da ORGANIZAÇÃO, e a próxima página voltava a ser varredura.
   *
   * Estando no schema, a chave atravessa as quatro peças com a cerca
   * `rota-le-todo-filtro-do-schema` cobrindo a rota, e o predicado compõe com
   * os demais antes do `.limit` — cursor e `has_more` passam a ser honestos
   * para o conjunto do contato.
   */
  contact_id: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

export const listMessagesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
