/**
 * Superfície ESTÁTICA das tools do agente (description + inputSchema) — parte do
 * prefixo estável de cache (F2-17). Única fonte: o handler monta as tools reais
 * daqui (+ execute do closure) e `scripts/ops-count-prefix.ts` mede o prefixo
 * real sem precisar de um run. Nada volátil entra aqui, por construção.
 *
 * Mora neste arquivo para o medidor importar sem puxar `inbound-turn` (e com
 * ele o client admin / `lib/env`).
 */
import { TIPOS_DE_CASO, TIPOS_DE_CASO_PARA_A_IA } from "@/lib/ai/case-copy";
import { z } from "zod";

export const AGENT_TOOL_DEFS = {
  get_lead_context: {
    description:
      "Relê o contexto curado do lead nesta organização: dados do contato e as últimas mensagens da conversa.",
    inputSchema: z.object({}),
  },
  send_message: {
    description:
      "Envia UMA mensagem de WhatsApp ao lead desta conversa. É o ÚNICO jeito de falar com o lead; texto fora desta tool nunca é enviado.",
    inputSchema: z.object({
      body: z.string().min(1).describe("corpo da mensagem, em pt-br, pronto para envio"),
    }),
  },
  update_lead_state: {
    description:
      "Marca um avanço REAL no funil deste lead: stage (new → contacted → qualifying → qualified → " +
      "negotiating → won | lost; só o PRÓXIMO estágio válido — regressão é rejeitada), qualification " +
      "(budget/authority/need/timeline), next_action e reason (evidência curta do avanço). " +
      "Nunca invente avanço sem evidência na conversa.",
    // Schema LARGO só para o SDK (o modelo vê os campos); a validação REAL é a
    // whitelist .strict() dentro de applyLeadStateUpdate — campo extra/forjado
    // vira erro de ENSINO ao modelo, nunca exceção do SDK nem strip silencioso.
    inputSchema: z
      .object({
        stage: z.string().optional().describe("novo estágio do funil (só o próximo válido)"),
        qualification: z
          .object({})
          .passthrough()
          .optional()
          .describe("qualificação: budget, authority, need, timeline"),
        next_action: z
          .string()
          .nullable()
          .optional()
          .describe("próxima ação concreta combinada com o lead"),
        reason: z.string().optional().describe("evidência curta do avanço (vai ao audit do CRM)"),
      })
      .passthrough(),
  },
  schedule_followup: {
    description:
      "Agenda o SEU próprio retorno a este lead num momento futuro (follow-up). Use sempre que " +
      "prometer voltar a falar depois (ex.: \"te retorno amanhã de manhã\", \"confirmo na segunda\"). " +
      "Um agendamento por promessa; o sistema fará o follow-up sozinho no horário combinado — " +
      "depois de agendar, encerre o turno.",
    // Schema LARGO para o SDK (o modelo vê os campos); a validação REAL é a whitelist
    // .strict() + guard de prototype pollution dentro de applyScheduleFollowup — campo
    // extra/forjado e data inválida viram erro de ENSINO ao modelo, nunca exceção do SDK.
    inputSchema: z
      .object({
        reason: z.string().describe("por que agendar o retorno"),
        promised_at: z
          .string()
          .describe("data/hora ISO 8601 do retorno (no futuro), ex.: \"2026-07-15T14:00:00Z\""),
        promise: z.string().describe("o que você prometeu ao lead"),
        context_snapshot: z
          .string()
          .nullable()
          .optional()
          .describe("contexto curto para o seu run futuro"),
      })
      .passthrough(),
  },
  save_lead_note: {
    description:
      "Salva uma nota DURÁVEL na memória deste lead (persiste entre conversas). Use para fatos que " +
      "você vai querer lembrar depois: preferências, contexto pessoal, restrições, o que já foi " +
      "oferecido. A headline (linha curta) entra sempre no índice de memória do lead; o corpo completo " +
      "fica guardado e você o relê sob demanda com get_lead_note. Para CONSOLIDAR notas antigas, " +
      "liste os ids delas em \"supersedes\" (você os vê no índice) — elas são removidas ao salvar a nova.",
    // Schema LARGO para o SDK (o modelo vê os campos); a validação REAL é a whitelist
    // .strict() + guard de prototype pollution dentro de applySaveLeadNote — campo
    // extra/forjado vira erro de ENSINO ao modelo, nunca exceção do SDK nem strip silencioso.
    inputSchema: z
      .object({
        headline: z.string().describe("linha curta do índice (sempre visível no prompt)"),
        body: z.string().describe("corpo completo da nota (lido sob demanda por get_lead_note)"),
        supersedes: z
          .array(z.string())
          .optional()
          .describe("ids de notas que esta substitui/consolida (vistos no índice de memória)"),
      })
      .passthrough(),
  },
  get_lead_note: {
    description:
      "Lê o CORPO completo de UMA nota da memória deste lead pelo id (o id aparece no índice de memória, " +
      "entre colchetes). Use quando a headline no índice não bastar e você precisar do detalhe.",
    inputSchema: z
      .object({
        note_id: z.string().describe("id da nota (como aparece no índice, entre colchetes)"),
      })
      .passthrough(),
  },
  search_knowledge: {
    description:
      "Busca na BASE DE CONHECIMENTO da organização (FAQ, políticas, catálogo) os trechos mais " +
      "relevantes para uma pergunta. Use ANTES de responder qualquer dúvida factual sobre produto, " +
      "preço, prazo, política ou funcionamento — responda com base nos trechos retornados e não " +
      "invente o que não encontrar. Sem resultados = diga que vai confirmar, nunca chute.",
    inputSchema: z
      .object({
        query: z.string().min(2).describe("a pergunta ou termos a buscar, em pt-br"),
      })
      .passthrough(),
  },
  request_human_handoff: {
    description:
      "Passa a conversa para um ATENDENTE HUMANO imediatamente. Use quando o lead pedir para falar com " +
      "uma pessoa, quando a situação exigir alguém humano (reclamação séria, questão jurídica/financeira " +
      "sensível) ou quando você atingir o limite do que pode resolver. " +
      "AVISE O LEAD ANTES: mande uma mensagem dizendo que você vai chamar alguém da equipe e SÓ ENTÃO " +
      "chame esta ferramenta — depois dela você não consegue mais falar com ele. Se você não avisar, " +
      "o sistema manda um aviso padrão no seu lugar. Acionada a ferramenta, encerre o turno. " +
      "NUNCA diga ao lead que \"já chamei alguém\" ou \"já passei para a equipe\" sem ter chamado esta " +
      "ferramenta NO MESMO turno — a frase no passado não substitui a ação, e ninguém é avisado de verdade. " +
      "Preencha por_que, o_que_tentei e cliente_quer — quem assumir só vê o que você escrever aqui.",
    // Schema LARGO para o SDK (o modelo vê o campo); a validação REAL é a whitelist .strict()
    // + guard de prototype pollution dentro de applyRequestHumanHandoff — campo extra/forjado
    // vira erro de ENSINO ao modelo, nunca exceção do SDK nem strip silencioso.
    //
    // ⚠️ ESPELHO: as chaves aqui e as de `requestHumanHandoffInputSchema`
    // (`human-handoff.ts`) são o MESMO conjunto, e
    // `tests/unit/passagem-tool-schema-espelhado.test.ts` as compara. Campo só
    // deste lado = o modelo preenche e a whitelist recusa, virando erro de
    // ensino a cada chamada; campo só do outro = o modelo nunca sabe que existe.
    //
    // Os `.describe()` são o ÚNICO lugar onde o modelo aprende o que escrever, e
    // é por isso que eles trazem exemplo em vez de definição.
    inputSchema: z
      .object({
        por_que: z
          .string()
          .optional()
          .describe(
            "em uma frase, por que você não consegue resolver e está passando para uma pessoa",
          ),
        o_que_tentei: z
          .array(
            z.object({
              o_que: z
                .string()
                .describe("o que você tentou (ex.: \"busquei na base a política de desconto\")"),
              desfecho: z.string().optional().describe("no que deu (ex.: \"a política só vai até 10%\")"),
            }),
          )
          .optional()
          .describe("o que você já tentou, na ordem — evita que a pessoa refaça o mesmo caminho"),
        cliente_quer: z
          .string()
          .optional()
          .describe("o que a pessoa está pedindo, nas palavras dela"),
        reason: z.string().optional().describe("sinônimo antigo de por_que (ainda aceito)"),
      })
      .passthrough(),
  },
  read_skill_reference: {
    description:
      "Lê o conteúdo de UMA reference (arquivo de apoio) do pacote de uma skill situacional que já " +
      "CASOU neste turno. Use quando o corpo da skill ativa mencionar uma reference e você precisar do " +
      "detalhe completo dela. Só funciona para skills ativas AGORA — pedir skill não ativa ou caminho " +
      "fora do manifesto dela volta erro.",
    inputSchema: z
      .object({
        skill_name: z
          .string()
          .min(1)
          .describe("nome da skill ativa neste turno (como aparece no bloco de skills)"),
        ref_path: z.string().min(1).describe("caminho da reference dentro do pacote da skill"),
      })
      .passthrough(),
  },
  open_human_case: {
    description:
      "Abra um caso para um humano de retaguarda quando você NÃO conseguir resolver o pedido do lead " +
      "sozinho (liberar acesso, corrigir algo num sistema, uma decisão que exige uma pessoa). Você CONTINUA " +
      "conversando com o lead normalmente — não silencia. Use SEMPRE que for prometer ao lead que alguém vai " +
      "verificar/resolver: prometer sem abrir o caso é proibido. Isso vale mesmo quando você nomeia a " +
      "pessoa (\"vou confirmar com o Fulano\", \"já registrei com a equipe\") — nomear alguém não abre o caso; " +
      "só esta ferramenta abre. Chame-a NO MESMO turno em que fizer a promessa, nunca depois.",
    // Schema LARGO para o SDK (o modelo vê os campos); a validação REAL é a whitelist
    // .strict() openHumanCaseInputSchema (human-cases.ts) — campo extra/forjado vira
    // erro de ENSINO ao modelo, nunca exceção do SDK nem strip silencioso.
    inputSchema: z
      .object({
        title: z.string().describe("título curto, ex.: \"Liberar acesso ao painel\""),
        summary: z.string().describe("o que o lead precisa, em pt-br"),
        blocker: z.string().describe("por que você não consegue resolver sozinho"),
        // O assunto serve para quem TRIA a fila separar antes de ler. O detalhe
        // continua no título e no resumo — este campo não os substitui, e por
        // isso a lista é curta: muitas opções produzem classificação
        // inconsistente, e aí o filtro atrapalha em vez de ajudar.
        kind: z
          .enum(Object.keys(TIPOS_DE_CASO) as [string, ...string[]])
          .describe(
            "do que o caso trata, para a equipe triar: " +
              Object.entries(TIPOS_DE_CASO_PARA_A_IA)
                .map(([k, o]) => `${k} (${o})`)
                .join("; ") +
              ". Na dúvida entre dois, escolha o que descreve o PEDIDO, não o obstáculo.",
          ),
      })
      .passthrough(),
  },
  provide_case_update: {
    description:
      "Quando um caso está esperando informação do cliente e você já colheu essa informação na conversa, " +
      "use esta tool para devolver a informação ao humano responsável. Não invente — só o que o lead disse.",
    // Schema LARGO para o SDK; a validação REAL é a whitelist .strict()
    // provideCaseUpdateInputSchema (human-cases.ts).
    inputSchema: z
      .object({
        case_id: z.string().describe("id do caso aberto"),
        info: z.string().describe("a informação colhida do lead"),
      })
      .passthrough(),
  },
  send_template: {
    description:
      "Envia um TEMPLATE aprovado do WhatsApp. Use SOMENTE quando o send_message for recusado " +
      "porque a janela de 24 horas com o contato fechou — a mensagem de erro diz quando é o caso. " +
      "Você precisa do nome exato do template, do idioma e de um valor para CADA parâmetro. " +
      "Se faltar valor, a resposta diz quais e você pode chamar de novo; qualquer outro erro " +
      "significa que um humano precisa agir — encerre o turno sem insistir.",
    inputSchema: z
      .object({
        template_name: z.string().min(1).describe("nome exato do template, como aprovado na Meta"),
        language: z.string().min(2).describe("código do idioma, ex.: pt_BR"),
        values: z
          .record(z.string(), z.string())
          .describe(
            "valor de cada parâmetro, na chave que a tela de templates mostra (ex.: \"1\", \"2\")",
          ),
      })
      .passthrough(),
  },
} as const;
