/**
 * A CÓPIA QUE O TITULAR RECEBE — o `data.json` que vai por link no e-mail de
 * acesso, no Brasil e fora dele (doc 103, resposta A; Portugal desde o #2354).
 *
 * O coletor (`collectExportData`) monta o payload INTEIRO, e é dele que sai o
 * PDF — que não muda com isto. O arquivo entregue é esta projeção: o mesmo
 * payload sem o que é da EQUIPE e não do titular. Três categorias saem, e só
 * elas; cada linha abaixo diz por quê.
 *
 * 1. Chave de banco (`id` e `*_id` de cada linha). Não identifica nada para quem
 *    lê, e é o mapa interno do sistema. Ficam: `external_id` do pedido (o número
 *    que a loja mostrou ao cliente) e o envelope — `request_id` é o protocolo do
 *    pedido dele (o e-mail cita o começo) e `organization_id` é o "ID interno"
 *    que o PDF já imprime para o suporte.
 * 2. Nota da equipe e dado de funcionário: o texto que a equipe escreveu PARA a
 *    equipe, e o nome ou telefone de quem trabalha lá (dado de terceiro).
 * 3. Encanamento: estado de sincronização, código de motor, erro interno,
 *    contagem de reenvio — metadado que não diz nada sobre a pessoa.
 *
 * Duas decisões do doc 110 (o dono respondeu "1A, 2A, 3A"):
 *
 * - 1A: das ações da IA (`ai_agent_runs`) fica a LISTA do que ela fez — o nome
 *   de cada ação e quando rodou — e sai o que ela digitou em cada uma. O que
 *   ela digitou ao chamar um atendente sai também da passagem que essa chamada
 *   grava (`ORIGENS_DIGITADAS_PELA_IA`), e o que ela digitou no caso — ao
 *   abri-lo (`TEXTO_DA_IA_NO_CASO`) e nas notas e no encerramento
 *   (`ATORES_DO_CASO_QUE_ESCREVEM_PARA_A_EQUIPE`). O termo
 *   de uma busca de contato pode ser o nome ou o telefone de OUTRO cliente
 *   (`lib/mcp/tools/contacts.ts`), e a razão de chamar um atendente
 *   (`lib/mcp/tools/handoff.ts`) é texto escrito PARA a equipe. A régua: texto
 *   escrito para a equipe por quem pode ser a IA ou uma integração (autoria
 *   desconhecida) sai; a opinião de uma PESSOA da equipe segue a 3A. Por lista de
 *   permissão, não de proibição: ação nova da IA nasce sem argumento no
 *   arquivo. Revê o #1965 só nesse ponto. Vale para todo país.
 * - 3A: em Portugal, as seis notas que a equipe escreve SOBRE o titular voltam
 *   ao arquivo, com o texto e a data e sem o nome de quem escreveu
 *   (`NOTAS_SOBRE_O_TITULAR`). Pelo RGPD a opinião registrada sobre a pessoa é
 *   dado dela (TJUE, Nowak, 2017), e o art. 15.º, n.º 4 só autoriza proteger
 *   OUTRAS pessoas — o funcionário, não o texto. O Brasil segue sem elas
 *   (doc 103, A). Leitura do mantenedor, não parecer jurídico.
 *
 * TODA seção do payload está classificada em `O_QUE_FICA` ou em
 * `SECOES_DA_EQUIPE`, com o motivo: o `satisfies` faz uma seção nova no
 * `ExportPayload` não compilar até alguém decidir se ela vai ao titular, e
 * `tests/unit/lgpd-copia-do-titular.test.ts` cobra o mesmo do payload que o
 * coletor devolve.
 *
 * Saem campos inteiros, nunca trechos de texto: o que fica, fica como foi
 * coletado. Campo que o PDF já imprime NÃO entra nesta lista (`appointments.notes`,
 * `reply_drafts.feedback`): o PDF não muda, e tirar do arquivo o que o relatório
 * entrega não protegeria nada.
 */
import type { OrigemDaPassagem } from "@/lib/escalacao/passagem";
import type { ExportPayload } from "@/lib/lgpd/export-collector";

/** Seções que não vão no arquivo. */
export const SECOES_DA_EQUIPE = {
  conversation_notes:
    "nota interna: o que a equipe anotou para a equipe na conversa, com o nome de quem escreveu e o caminho do anexo no armazenamento (em Portugal, o texto e a data voltam: `NOTAS_SOBRE_O_TITULAR`)",
  case_chat_messages: "a conversa interna da equipe com a IA sobre o caso",
  appointment_notices:
    "aviso da Central PARA a equipe sobre o compromisso (registrar desfecho, revisar recuperação): tarefa interna, não dado dele",
} as const satisfies Partial<Record<keyof ExportPayload, string>>;

/**
 * As seções que vão ao titular, e por quê. Seção com campos em
 * `CAMPOS_DA_EQUIPE` vai sem eles.
 */
export const O_QUE_FICA = {
  request_id: "o protocolo do pedido dele (o e-mail cita o começo)",
  organization_id: "o \"ID interno\" que o PDF já imprime para o suporte",
  organization_legal_name: "o controlador: quem responde pelos dados",
  organization_display_name: "o nome com que o controlador se apresenta a ele",
  dpo_email: "o encarregado a quem ele se dirige",
  lei_citada: "a lei que fundamenta a resposta",
  lei_rotulo: "o rótulo dessa lei no país dele",
  fuso: "o fuso das datas do documento",
  art15: "as informações do art. 15.º do RGPD devidas a ele",
  messages_completas: "todas as mensagens dele, sem o recorte de 100 (doc 110, 2A: também no Brasil)",
  secoes_no_limite: "a ressalva de que pode haver mais registros do que os entregues",
  documento_rotulo: "o nome do documento dele no país (\"CPF\")",
  generated_at: "quando a cópia foi gerada",
  no_local_footprint: "se a instalação tem ou não dado dele",
  contact: "a ficha dele, inclusive os campos personalizados e a origem do anúncio",
  consents: "os consentimentos que ele deu ou negou",
  conversations: "as conversas dele: canal, estado e datas",
  messages_count_total: "quantas mensagens ele trocou",
  messages_recent: "as 100 mensagens mais recentes dele",
  leads: "as oportunidades abertas para ele: título, estado e valor",
  honorarios_contratos: "o contrato de honorários dele (sem a divisão interna do escritório)",
  honorarios_parcelas: "as parcelas que ele paga",
  orders: "os pedidos dele na loja",
  activities: "o que foi registrado sobre ele e quando",
  checkpoints: "o resumo que a máquina fez da conversa com ele (LGPD art. 20)",
  appointments: "os compromissos dele, com o link da reunião e a anotação que o PDF já imprime",
  sales: "as compras dele e por que foram canceladas ou estornadas",
  proposals: "as propostas comerciais enviadas a ele",
  tasks: "o que se combinou fazer para ele",
  webhook_captures:
    "o que ele enviou num formulário, com o IP e o navegador de onde enviou: dado dele, origem do contato (art. 19, II)",
  audit_log_extract: "o registro de quem acessou e mudou os dados dele (o PDF já entrega)",
  meeting_deliveries: "o envio do link da reunião a ele, e em que estado ficou",
  voice_calls: "as chamadas de voz dele: número, duração e como terminaram",
  prospecting_candidates:
    "o dado público do negócio dele que originou a abordagem (origem dos dados, art. 19, II)",
  cases:
    "que o atendimento dele parou e foi para a equipe: quando, por qual caminho e como terminou (o texto que a IA digitou ao abrir sai: `CAMPOS_DA_EQUIPE`)",
  case_events:
    "a linha do tempo do caso dele: cada passo, quando, e o que ele informou (sem o texto escrito para a equipe)",
  demandas: "o pedido dele: estado, se quem cuida é a IA ou uma pessoa, próximo passo e desfecho",
  passagens:
    "a passagem do atendimento dele a uma pessoa: o motivo, quando, se ele foi avisado, as últimas palavras dele e — quando não foi a IA quem digitou — o pedido em uma linha",
  avisos_de_caso: "que a equipe foi avisada do caso dele, e quando",
  campaign_recipients: "as mensagens de campanha que ele recebeu, e por que foi ou não incluído",
  campaign_suppressions: "a exclusão dele das campanhas",
  channel_session_groups: "os grupos de WhatsApp ligados a ele",
  group_messages_authored: "o que ele escreveu em grupos",
  conversation_drafts: "o texto escrito PARA ele por outro sistema",
  contact_field_proposals: "o dado dele que a IA ouviu na conversa e propôs gravar, e o que se decidiu",
  lead_notes: "a memória que a IA guarda sobre ele (LGPD art. 20)",
  ai_agent_runs:
    "o que a IA fez na conversa com ele e quando: o nome de cada ação, sem o que ela digitou (#1965, revisto no doc 110, 1A)",
  lead_state: "o próximo passo e a qualificação dele, por máquina (LGPD art. 20)",
  b2b: "a pessoa para quem a ficha dele aponta, os vínculos com empresas e as linhas de planilha sobre ele",
  reply_drafts: "as respostas sugeridas a ele e a revisão (o PDF já entrega)",
} as const;

/** Toda seção do payload decidida: a que falta não compila. */
const _todaSecaoDecidida = { ...O_QUE_FICA, ...SECOES_DA_EQUIPE } satisfies Record<keyof ExportPayload, string>;
void _todaSecaoDecidida;

/**
 * O título, o resumo e o bloqueio do caso são digitados por quem ABRE o caso, e
 * só a IA abre (`openCase`, `lib/agent-engine/agent/human-cases.ts`): pela
 * ferramenta dela, ou pelo sistema no fail-safe, em que o resumo é a mensagem
 * que ela tentou mandar e foi barrada. É texto da IA para a fila da equipe —
 * a mesma régua de `ORIGENS_DIGITADAS_PELA_IA` (doc 110, 1A). Vale para todo
 * país: a 3A devolve a opinião de uma PESSOA da equipe, não o texto da IA.
 */
const TEXTO_DA_IA_NO_CASO =
  "o que a IA (ou o sistema, no fail-safe) digitou ao abrir o caso, para a fila da equipe (doc 110, 1A)";

/** Campos que saem de cada linha da seção (ou do objeto, quando a seção é um só). */
export const CAMPOS_DA_EQUIPE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  honorarios_contratos: {
    repasse_advogado_pct: "quanto o escritório repassa ao advogado: divisão interna, não dado dele",
  },
  meeting_deliveries: { run_after: "quando a fila interna vai tentar de novo" },
  activities: { source_module: "telemetria: qual módulo do sistema registrou a atividade" },
  appointments: {
    google_base_projection: "estado da sincronização com o Google Agenda",
    google_conflict: "estado da sincronização com o Google Agenda",
    google_pending_write: "estado da sincronização com o Google Agenda",
    meeting_state: "estado interno da criação do link da reunião (o link em si fica)",
  },
  case_events: {
    metadata: "metadado do motor do caso: guarda o telefone (mascarado) do plantão avisado e chaves internas",
  },
  cases: {
    title: TEXTO_DA_IA_NO_CASO,
    summary: TEXTO_DA_IA_NO_CASO,
    blocker: TEXTO_DA_IA_NO_CASO,
  },
  demandas: {
    assunto:
      "só é preenchido nas demandas criadas da fila de casos antiga (migration 0280, R1), e é cópia do `title` do caso: sairia por uma porta e voltaria por esta",
  },
  passagens: {
    motor: "qual dos dois motores do sistema passou a conversa",
    origem: "o caminho de código por onde a passagem entrou (o motivo, `motivo_codigo`, fica)",
    body:
      "a narrativa montada PARA quem vai atender (`montarBriefingDaPassagem`): repete o texto livre de quem passou — o `por_que`, o `cliente_quer` e o `o_que_tentei` da IA (doc 110, 1A) e a razão de quem escalou — e o resto já vai em `title`, `notes`, `tentativas` e `motivo_codigo`",
  },
  avisos_de_caso: {
    destino_mascarado: "telefone, mesmo mascarado, do FUNCIONÁRIO avisado: dado de terceiro",
    erro_codigo: "código de erro da entrega do aviso à equipe",
    tentativas: "contagem de reenvio do aviso à equipe",
  },
  prospecting_candidates: { error: "mensagem de erro interna da abordagem" },
  "b2b.linhas_importadas": { error: "erro interno da importação da planilha" },
};

/**
 * As notas que a equipe escreve SOBRE o titular (doc 110, 3A). Saem no Brasil
 * (doc 103, A); em Portugal ficam — ver o cabeçalho. Além destes campos, são
 * notas sobre ele a seção `conversation_notes` (em Portugal só `body` e
 * `created_at`) e o `body` de `case_events` com ator humano. O `body` com ator
 * `agent` não é nota de pessoa: sai em todo país (`ATORES_DO_CASO_QUE_ESCREVEM_PARA_A_EQUIPE`).
 */
export const NOTAS_SOBRE_O_TITULAR: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  sales: { notes: "anotação que o atendente escreveu na comanda" },
  "b2b.pessoa": { notes: "anotação da equipe sobre a pessoa na base de empresas" },
  "b2b.vinculos": { notes: "anotação da equipe sobre o vínculo com a empresa" },
  contact_field_proposals: { motivo_recusa: "por que a equipe recusou a proposta de gravar um dado dele" },
  passagens: {
    content:
      "a razão que a pessoa da equipe escreveu ao escalar o caso (origem `caso_escalado`). Nas outras origens ele sai em todo país: ver `ORIGENS_DIGITADAS_PELA_IA`",
  },
};

/**
 * Os países em que as notas sobre o titular vão no arquivo (doc 110, 3A). O
 * dono decidiu Portugal; país novo entra aqui por decisão, não por herança.
 */
const PAISES_QUE_RECEBEM_AS_NOTAS = new Set(["PT"]);

/**
 * A origem em que a LINHA garante que o `content` foi escrito por uma pessoa da
 * equipe (`app/api/v1/ai/cases/[id]/reply`). Não é a única em que uma pessoa
 * pode ter escrito: ver `ORIGENS_DIGITADAS_PELA_IA`.
 */
const ORIGEM_ESCRITA_PELA_EQUIPE: OrigemDaPassagem = "caso_escalado";

/**
 * As origens em que o texto livre da passagem — `title` (o `cliente_quer`),
 * `tentativas` (o `o_que_tentei`) e `content` (o `por_que`/`reason`) — foi
 * digitado por quem chamou a ferramenta de atendente, e não montado pelo
 * sistema (`montarBriefingDaPassagem`). Esse texto sai em todo país (doc 110,
 * 1A: "a razão, o que a IA já tentou e o que o cliente quer").
 *
 * - `ferramenta_do_modelo`: a IA nativa (`lib/agent-engine/agent/human-handoff.ts`).
 * - `mcp_externo`: quem chamou `crm_request_human_handoff` (`lib/mcp/tools/handoff.ts`)
 *   com um token — um agente de IA, uma integração OU uma pessoa com token
 *   próprio. A linha NÃO guarda o ator (0291 não tem coluna para isso), então a
 *   autoria aqui é DESCONHECIDA e a regra é a conservadora: sai, inclusive em
 *   Portugal, onde o `content` de uma pessoa voltaria pela 3A. Limite
 *   conhecido: a razão que uma pessoa escreveu por MCP não volta em Portugal.
 *   Para devolvê-la, a passagem precisa gravar o tipo do ator.
 *
 * Nas outras origens `tentativas` é sempre vazio e `title` é a leitura do
 * checkpoint, que o arquivo já entrega em `checkpoints`.
 */
const ORIGENS_DIGITADAS_PELA_IA: ReadonlySet<string> = new Set<OrigemDaPassagem>([
  "ferramenta_do_modelo",
  "mcp_externo",
]);

/**
 * O `body` de evento de caso com estes atores é texto escrito PARA a equipe por
 * quem não se sabe se é IA ou pessoa, e sai em todo país (doc 110, 1A) — a
 * mesma régua de `ORIGENS_DIGITADAS_PELA_IA`. Hoje só `agent_noted` tem `body`
 * com ator `agent`: a nota de `crm_add_case_note` e a de encerramento de
 * `crm_close_human_case` (`lib/mcp/tools/escalacao.ts`), chamadas com token —
 * IA, integração ou pessoa, a linha não diz qual. As duas ferramentas pedem o
 * texto "para o próximo atendente".
 *
 * Ficam: `human` segue a 3A (nota de pessoa sobre ele: Portugal sim, Brasil
 * não); `lead` é o que ele informou (`provideCaseUpdate`); `system` não grava
 * `body`.
 */
const ATORES_DO_CASO_QUE_ESCREVEM_PARA_A_EQUIPE = new Set(["agent"]);

/** As chaves de banco que ficam, e por quê — ver o item 1 do cabeçalho. */
const CHAVES_QUE_FICAM = new Set(["external_id"]);

const ehChaveDeBanco = (campo: string) =>
  !CHAVES_QUE_FICAM.has(campo) && (campo === "id" || campo.endsWith("_id"));

type Objeto = Record<string, unknown>;

const ehObjeto = (v: unknown): v is Objeto => typeof v === "object" && v !== null && !Array.isArray(v);

/** As linhas de uma seção: os itens da lista, ou o próprio objeto. */
const linhasDe = (v: unknown): Objeto[] =>
  Array.isArray(v) ? v.filter(ehObjeto) : ehObjeto(v) ? [v] : [];

/**
 * As ações da IA sem o que ela digitou (doc 110, 1A): da forma de
 * `toolCallsParaOTitular` (passo → chamadas → args) ficam só `step`,
 * `tool_name` e `redacted`, por LISTA DE PERMISSÃO — campo novo não passa.
 */
function soOQueAIaFez(toolCalls: unknown): unknown[] {
  return linhasDe(toolCalls).map((passo) => ({
    ...(passo.step !== undefined ? { step: passo.step } : {}),
    ...(typeof passo.tool_name === "string" ? { tool_name: passo.tool_name } : {}),
    ...(passo.redacted === true ? { redacted: true } : {}),
    tool_calls: linhasDe(passo.tool_calls).map((c) => ({
      tool_name: typeof c.tool_name === "string" ? c.tool_name : "unknown",
    })),
  }));
}

// ---------------------------------------------------------------------------
// A projeção — linha a linha, sem cópia profunda do payload (#2576)
// ---------------------------------------------------------------------------

/**
 * O país decidido UMA vez na entrada: daí para baixo a projeção inteira depende
 * só deste objeto, e é o mesmo objeto que o escritor em partes usa — não existe
 * uma regra para a cópia em objeto e outra para o arquivo em stream.
 */
interface Projecao {
  /** Doc 110, 3A: as seis notas da equipe sobre ele voltam em Portugal. */
  recebeAsNotas: boolean;
}

const projecaoDe = (pais: string): Projecao => ({
  recebeAsNotas: PAISES_QUE_RECEBEM_AS_NOTAS.has(pais),
});

/**
 * As chaves que saem de UMA linha. Aqui só há DELEÇÃO (mais o `tool_calls` das
 * ações da IA, que `projetaLinha` reescreve) — e é isto que a cópia profunda de
 * antes tornava necessária: apagar no payload exigia primeiro copiá-lo. A lista
 * do que sai cabe numa linha, então o payload não precisa ser copiado para
 * alguém descobrir o que sobra (#2576).
 */
function chavesQueSaoDaLinha(secao: string, linha: Objeto, p: Projecao): Set<string> {
  const saida = new Set<string>();
  const campos = CAMPOS_DA_EQUIPE[secao];
  if (campos) for (const campo of Object.keys(campos)) saida.add(campo);
  if (!p.recebeAsNotas) {
    const notas = NOTAS_SOBRE_O_TITULAR[secao];
    if (notas) for (const campo of Object.keys(notas)) saida.add(campo);
  }
  if (secao === "passagens") {
    // Antes de `origem` sair (doc 110, 1A): sem ele a régua não sabe mais quem
    // digitou, e a ordem das duas decisões é a do cabeçalho — a de 1A primeiro.
    if (linha.origem !== ORIGEM_ESCRITA_PELA_EQUIPE) saida.add("content");
    if (ORIGENS_DIGITADAS_PELA_IA.has(String(linha.origem))) {
      saida.add("title");
      saida.add("tentativas");
    }
  }
  if (secao === "case_events") {
    const ator = String(linha.actor_kind);
    if (ATORES_DO_CASO_QUE_ESCREVEM_PARA_A_EQUIPE.has(ator) || (!p.recebeAsNotas && ator === "human")) {
      saida.add("body");
    }
  }
  for (const campo of Object.keys(linha)) if (ehChaveDeBanco(campo)) saida.add(campo);
  return saida;
}

/**
 * Uma linha projetada, num objeto NOVO — a linha de origem nunca é mutada, e o
 * PDF segue desenhado do payload inteiro. A chave de banco sai do NÍVEL DA
 * LINHA: dentro de um `jsonb` do titular (campos personalizados, origem do
 * anúncio) um `pedido_id` é dado dele, e fica.
 */
function projetaLinha(secao: string, linha: Objeto, p: Projecao): Objeto {
  const fora = chavesQueSaoDaLinha(secao, linha, p);
  const projetada: Objeto = {};
  for (const campo of Object.keys(linha)) if (!fora.has(campo)) projetada[campo] = linha[campo];
  // Reatribuição na chave JÁ EXISTENTE não muda a posição dela no objeto — é a
  // mesma ordem que `run.tool_calls = soOQueAIaFez(...)` dava na cópia de antes.
  if (secao === "ai_agent_runs") projetada.tool_calls = soOQueAIaFez(linha.tool_calls);
  return projetada;
}

/** Em Portugal a seção de notas volta com SÓ o texto e a data (doc 110, 3A). */
function linhaDoTitulo(secao: string, linha: Objeto, p: Projecao): Objeto {
  if (secao !== "conversation_notes" || !p.recebeAsNotas) return linha;
  // O anexo fica fora: o arquivo levaria o caminho interno no armazenamento e o
  // nome de quem escreveu (art. 15.º, n.º 4: protege OUTRAS pessoas).
  return { body: linha.body, created_at: linha.created_at };
}

/**
 * Uma seção projetada. `contact` e `art15` são objetos (e viram uma "linha"
 * para a régua de chave de banco, como na cópia de antes); `b2b` é a única que
 * agrupa outras — cada bloco dela tem as suas linhas, com o caminho completo
 * (`b2b.pessoa`), que é como `CAMPOS_DA_EQUIPE` e `NOTAS_SOBRE_O_TITULAR`
 * nomeiam os campos dela.
 */
function projetaSecao(secao: string, valor: unknown, p: Projecao): unknown {
  if (Array.isArray(valor)) {
    const projetadas: unknown[] = [];
    for (let i = 0; i < valor.length; i++) {
      const item = valor[i];
      // O que não é objeto não tem chave de banco a tirar; `undefined` de array
      // é `null` no JSON, como deixava a cópia profunda de antes (`stringify`
      // seguido de `parse`).
      projetadas.push(ehObjeto(item) ? projetaLinha(secao, linhaDoTitulo(secao, item, p), p) : (item ?? null));
    }
    return projetadas;
  }
  if (secao === "b2b" && ehObjeto(valor)) {
    const agrupada: Objeto = {};
    for (const [chave, bloco] of Object.entries(valor)) {
      if (bloco === undefined) continue;
      agrupada[chave] = projetaSecao(`b2b.${chave}`, bloco, p);
    }
    return agrupada;
  }
  return ehObjeto(valor) ? projetaLinha(secao, valor, p) : valor;
}

/**
 * As seções do arquivo, na ordem em que saem: o payload, menos o que é da
 * equipe. `conversation_notes` é deixada de fora do laço e reescrita NO FIM em
 * Portugal — a mesma ordem que o `delete` + reatribuição de antes dava ao
 * arquivo (apagar e repor move a chave para o final).
 *
 * Seção com valor `undefined` não vira chave: é o que o `JSON.parse(
 * JSON.stringify())` de antes descartava, e o arquivo não pode mudar por isto.
 */
function* planoDeSecoes(data: ExportPayload, pais: string): Generator<[string, unknown]> {
  const daEquipe = new Set(Object.keys(SECOES_DA_EQUIPE));
  for (const [secao, valor] of Object.entries(data)) {
    if (valor === undefined || typeof valor === "function") continue;
    if (secao === "conversation_notes" || daEquipe.has(secao)) continue;
    yield [secao, valor];
  }
  if (PAISES_QUE_RECEBEM_AS_NOTAS.has(pais) && data.conversation_notes !== undefined) {
    yield ["conversation_notes", data.conversation_notes];
  }
}

/**
 * O `data.json` do titular, para o país da organização (`perfil.codigo`, a
 * mesma leitura única do worker). Não altera `data` — o PDF é desenhado a
 * partir dele. O que era copiar o payload inteiro (`stringify` seguido de
 * `parse`) e apagar em cima da cópia virou a projeção acima, linha a linha: o
 * mesmo resultado, sem uma segunda cópia do payload em memória (#2576).
 *
 * No caso, o `body` de evento com ator humano (`human_replied`) é a nota de
 * quem resolveu, o motivo de quem escalou ou o pedido de quem precisou de mais
 * informação (`lib/agent-engine/agent/human-cases.ts`): nota da equipe sobre
 * ele, que segue `NOTAS_SOBRE_O_TITULAR`. O `body` de ator `agent` sai em todo
 * país (`ATORES_DO_CASO_QUE_ESCREVEM_PARA_A_EQUIPE`); o que ele informou fica.
 */
export function copiaDoTitular(data: ExportPayload, pais: string): Objeto {
  const p = projecaoDe(pais);
  const copia: Objeto = {};
  for (const [secao, valor] of planoDeSecoes(data, pais)) copia[secao] = projetaSecao(secao, valor, p);
  return copia;
}

// ---------------------------------------------------------------------------
// O arquivo em partes — o mesmo resultado, escrito sem materializar
// ---------------------------------------------------------------------------

const INDENTE = "  ";

const temJson = (valor: unknown): valor is { toJSON: () => unknown } =>
  typeof valor === "object" &&
  valor !== null &&
  typeof (valor as { toJSON?: unknown }).toJSON === "function";

/**
 * `JSON.stringify(valor, null, 2)` de UM valor, com o recuo do nível em que ele
 * vai dentro do documento — a regra é a do `JSON.stringify`, porque a escrita em
 * partes tem de produzir byte a byte o mesmo arquivo que ele produzia.
 */
function escrito(valor: unknown, nivel: number): string {
  const v = temJson(valor) ? valor.toJSON() : valor;
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
  // função e símbolo: fora de objeto nem entram no JSON, de array viram null.
  if (typeof v !== "object") return "null";
  const recuo = INDENTE.repeat(nivel);
  const filho = INDENTE.repeat(nivel + 1);
  if (Array.isArray(v)) {
    // Índice, e não `map`: array com buraco tem de virar `null`, como no de antes.
    if (v.length === 0) return "[]";
    const itens: string[] = [];
    for (let i = 0; i < v.length; i++) itens.push(filho + escrito(v[i], nivel + 1));
    return `[\n${itens.join(",\n")}\n${recuo}]`;
  }
  const campos: string[] = [];
  for (const [chave, bruto] of Object.entries(v)) {
    const campo = temJson(bruto) ? bruto.toJSON() : bruto;
    if (campo === undefined || typeof campo === "function" || typeof campo === "symbol") continue;
    campos.push(filho + JSON.stringify(chave) + ": " + escrito(campo, nivel + 1));
  }
  if (campos.length === 0) return "{}";
  return `{\n${campos.join(",\n")}\n${recuo}}`;
}

/**
 * Uma seção inteira, em partes. As LISTAS são o que importa: cada linha vira um
 * `yield` dela mesma, então o maior pedaço que existe de uma vez é uma linha —
 * e não a seção, nem o arquivo (`messages_completas` tem linhas de mais para
 * caber em memória como texto, #2576).
 */
function* escreveSecao(secao: string, valor: unknown, nivel: number, p: Projecao): Generator<string> {
  if (Array.isArray(valor)) {
    if (valor.length === 0) {
      yield "[]";
      return;
    }
    yield "[\n";
    const filho = INDENTE.repeat(nivel + 1);
    for (let i = 0; i < valor.length; i++) {
      if (i > 0) yield ",\n";
      yield filho;
      const item = valor[i];
      yield escrito(
        ehObjeto(item) ? projetaLinha(secao, linhaDoTitulo(secao, item, p), p) : (item ?? null),
        nivel + 1,
      );
    }
    yield `\n${INDENTE.repeat(nivel)}]`;
    return;
  }
  yield escrito(projetaSecao(secao, valor, p), nivel);
}

/**
 * O `data.json` do titular em PEDAÇOS, para o worker subir direto no upload
 * (`workers/lgpd-export-worker.ts`) — sem a cópia profunda, sem string do
 * arquivo inteiro e sem `Buffer` do arquivo inteiro morando na memória junto
 * do payload (#2576). O maior pedaço de uma vez é uma linha.
 *
 * Byte a byte é o `JSON.stringify(copiaDoTitular(data, pais), null, 2)` de
 * sempre: `tests/unit/lgpd-arquivo-em-stream.test.ts` compara os dois.
 */
export function* partesDoArquivoDoTitular(data: ExportPayload, pais: string): Generator<string> {
  const p = projecaoDe(pais);
  let primeiro = true;
  yield "{";
  for (const [secao, valor] of planoDeSecoes(data, pais)) {
    yield primeiro ? "\n" : ",\n";
    primeiro = false;
    yield `${INDENTE}${JSON.stringify(secao)}: `;
    yield* escreveSecao(secao, valor, 1, p);
  }
  yield primeiro ? "}" : "\n}";
}
