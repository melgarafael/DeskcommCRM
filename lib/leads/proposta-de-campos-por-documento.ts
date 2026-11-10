/**
 * O CARD PREENCHIDO A PARTIR DE UM DOCUMENTO (issue #3316) — a régua de
 * proposta de CAMPO DO NEGÓCIO, irmã de `lib/contacts/proposta-de-dado.ts`.
 *
 * ─── O defeito que este arquivo fecha ──────────────────────────────────────
 *
 * Num funil de pós-venda, os dados da viagem (localizador, horários, hotel,
 * apólice) chegam num voucher — e hoje alguém copia campo por campo à mão do
 * PDF para o card. É o passo que fica para depois; sem os dados no card, o
 * agente de IA pergunta ao cliente coisas que o próprio documento responde.
 *
 * Todo fornecedor manda esses dados num documento. LER o documento é o caminho
 * que serve a qualquer operadora, companhia, hotel ou seguradora — sem
 * integração com cada sistema (a issue descarta a alternativa de fornecedor
 * justamente por isso).
 *
 * ─── A DECISÃO QUE MORADAQUI: PROPOR, NUNCA GRAVAR ─────────────────────────
 *
 * Esta função cria LINHAS EM `lead_field_proposals` e NUNCA toca em
 * `crm_leads.custom_fields`. Quem grava é a confirmação humana
 * (`app/api/v1/leads/[id]/field-proposals/[pid]`), que passa pelos valores
 * confirmados pela porta de edição que JÁ existe (`updateLeadHandler`), com a
 * MESMA régua de tipo/lista/`padrao` (#2730/#2521) que a tela usa. Sem este
 * caminho, um voucher com o nome errado do hotel viraria card errado sem
 * ninguém ver — e a confirmação campo a campo é a única coisa que transforma
 * leitura de máquina em dado da operação.
 *
 * ─── O QUE ESTA RÉGUA RECUSA, E POR QUÊ ────────────────────────────────────
 *
 * Recusar cedo é o trabalho principal, igual à irmã de contatos. O documento
 * é lido por um MODELO, e modelo lê errado: proposta que não deveria ter nascido
 * custa atenção humana, e atenção gasta com ruído é o que faz a revisão virar
 * um botão que todos aprovam sem ler. As recusas, cada uma com seu motivo:
 *
 *   - `campo_fora_do_funil` / `campo_do_contato` — a issue manda propor SÓ os
 *     campos de `pipeline.settings.fields`; o campo do CONTATO (#2791) mora em
 *     `contacts.custom_fields` e não é do card.
 *   - `sem_trecho` — sem o trecho de origem a confirmação é um ato de fé: a
 *     tela mostra "valor atual × valor proposto × de onde veio", e a última
 *     coluna é justamente o que permite conferir.
 *   - `fora_da_lista` — `select`/`multiselect`/`searchable_select` gravam o
 *     valor CANÔNICO da opção (#2521); uma sétima grafia de Maceió não vira
 *     proposta, vira pergunta.
 *   - `fora_do_padrao` / `padrao_invalido` — o `padrao` do campo (#2730), com
 *     o MESMO veredito (`validaPadraoDoCampo` + `testaComPrazo`) das outras
 *     portas: regex quebrada fecha, não deixa passar.
 *   - `valor_igual_ao_atual` — nada a decidir; o voucher que confirma o que já
 *     está no card não enche a fila de revisão.
 *   - `ja_existe_proposta` — idempotência pelo índice parcial do banco (23505),
 *     o mesmo mecanismo da fila de contatos: o modelo vai reler o mesmo voucher
 *     em dez turnos.
 *
 * ─── A LEITURA DO DOCUMENTO É DE QUEM? ─────────────────────────────────────
 *
 * De quem já lê mídia hoje: o AGENTE, na conversa. Nenhum cliente de mídia novo
 * nasce aqui — a ferramenta MCP (`crm_propose_lead_fields_from_document`) recebe
 * o que o modelo leu, com o trecho de cada valor, e esta régua decide o que
 * disso pode virar proposta. A leitura do PDF/imagem continua sendo a de
 * sempre (partes de mídia do turno / transcrição), e o documento ANEXADO AO
 * NEGÓCIO (`crm_lead_attachments`, #3229) é o que a pessoa abre para conferir.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { CustomFieldDef } from "@/lib/schemas/settings";
import { camposDoFunil, camposPorEscopo } from "@/lib/leads/campos-do-funil";
import { opcoesDoCampo, validarValorPesquisavel, valorCanonico } from "@/lib/leads/campos-pesquisaveis";
import { validaPadraoDoCampo } from "@/lib/leads/padrao-do-campo";
import { testaComPrazo } from "@/lib/leads/padrao-do-campo-no-servidor";
import { settingsDoFunil } from "@/lib/leads/campos-exigidos";

/** O que o modelo leu no documento para UM campo do funil. */
export interface CampoLidoNoDocumento {
  /** A chave em `pipeline.settings.fields` — o MESMO `key` que o PATCH grava. */
  campo: string;
  /** O valor lido, como texto (o tipo do funil decide a conversão). */
  valor: string;
  /** De onde veio no documento. Sem isto a proposta não nasce. */
  trecho?: string | null;
}

export type MotivoSemPropostaDeCampo =
  /** O negócio não existe nesta organização (ou o lead sumiu entre ler e propor). */
  | "negocio_nao_encontrado"
  /** A leitura do funil falhou — fail-open da casa: sem definição não há o que cobrar. */
  | "funil_sem_campos"
  /** A chave não está declarada em `pipeline.settings.fields`. */
  | "campo_fora_do_funil"
  /** Está declarada, mas com `escopo: "contato"` — mora em `contacts.custom_fields`. */
  | "campo_do_contato"
  /** Sem trecho de origem a confirmação é um ato de fé. */
  | "sem_trecho"
  /** A forma não dá para gravar neste TIPO (data que não existe, número que não é número…). */
  | "valor_invalido"
  /** O valor não casa com nenhuma opção da lista. */
  | "fora_da_lista"
  /** O valor não cumpre o `padrao` (regex) do campo (#2730). */
  | "fora_do_padrao"
  /** O `padrao` do campo não compila: a gravação dele está bloqueada até correção. */
  | "padrao_invalido"
  /** Já é o valor do card. Nada a decidir. */
  | "valor_igual_ao_atual"
  /** Outra proposta do MESMO campo já espera decisão (índice único parcial). */
  | "ja_existe_proposta";

export interface RecusaDeCampoLido {
  campo: string;
  motivo: MotivoSemPropostaDeCampo;
}

export type ResultadoDaPropostaDeCampo =
  | { criada: true; id: string; campo: string; valorProposto: unknown; valorAnterior: unknown }
  | { criada: false; motivo: MotivoSemPropostaDeCampo };

/** Prazo padrão da fila — mesma conta da irmã de contatos (7 dias). */
const PRAZO_PADRAO_DIAS = 7;

/** Teto do VALOR lido: documento é texto, não repositório. */
const MAX_VALOR = 2000;

// ---------------------------------------------------------------------------
// A FORMA DE CADA TIPO — a fronteira entre "o documento diz" e "vai para a fila"
// ---------------------------------------------------------------------------

/**
 * O veredito de UM valor lido contra UMA definição do funil.
 *
 * Deliberadamente MODESTA, igual à da irmã de contatos: valida FORMA, não
 * veracidade. O voucher pode dizer "Hotel Playa" quando o cliente está em outro
 * hotel, e nenhuma regex resolve isso — quem resolve é a pessoa que confirma,
 * com o trecho na tela. Prometer mais aqui daria falsa segurança a quem aprova.
 *
 * A lista e o `padrao` NÃO são desta função: a lista é de `customFieldSchema` e
 * o `padrao` é a régua da #2730, compartilhada com as outras portas por
 * `validaPadraoDoCampo` — cada porta fazendo a sua própria regex é como as
 * réguas divergiram no histórico.
 */
export function valorDoTipoAceitavel(
  campo: Pick<CustomFieldDef, "type" | "options" | "allow_new" | "multiple" | "padrao">,
  valorBruto: string,
): { ok: true; valor: unknown } | { ok: false; motivo: MotivoSemPropostaDeCampo } {
  const texto = valorBruto.trim();
  if (texto === "" || texto.length > MAX_VALOR) return { ok: false, motivo: "valor_invalido" };

  const tipo = campo.type;

  if (tipo === "searchable_select" || tipo === "select" || tipo === "multiselect") {
    // A LISTA: o valor que casa vira o `value` canônico da opção; o que não casa
    // só entra se o campo abrir cadastro novo (`allow_new`, #2521). A comparação
    // é a MESMA do resto do produto (`valorCanonico`, sem caixa/aceso/espaço) —
    // uma segunda régua de casamento seria uma segunda grafia de "Maceió" em
    // produção.
    const itens = splitItens(texto, tipo);

    if (tipo === "searchable_select") {
      // `tipo` já é "searchable_select" aqui — quem decide lista×solto é o
      // `multiple` do campo, não o tipo (o split acima também já leu isso).
      const r = validarValorPesquisavel(campo, campo.multiple === true ? itens : itens[0]);
      return r.ok ? { ok: true, valor: r.valor } : { ok: false, motivo: "fora_da_lista" };
    }
    if (!campo.options || campo.options.length === 0) {
      // select/multiselect SEM opções cadastradas: a lista está vazia e não há
      // o que casar — recusar é o único desfecho que não é "deixa passar torto".
      return { ok: false, motivo: "fora_da_lista" };
    }
    const opcoes = opcoesDoCampo(campo);
    const canonicos: string[] = [];
    for (const item of itens) {
      const canonico = valorCanonico(opcoes, item);
      if (canonico === null) return { ok: false, motivo: "fora_da_lista" };
      if (!canonicos.includes(canonico)) canonicos.push(canonico);
    }
    return { ok: true, valor: tipo === "multiselect" ? canonicos : canonicos[0] };
  }

  if (tipo === "date") {
    // MESMA forma que a coluna espera (`AAAA-MM-DD`), com calendário de verdade:
    // `2026-02-30` tem a forma e não existe, e o card gravaria uma data que o
    // gatilho "N dias até uma data do funil" nunca alcançaria.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
    if (!m) return { ok: false, motivo: "valor_invalido" };
    const [, a, mo, d] = m;
    const ano = Number(a);
    const mes = Number(mo);
    const dia = Number(d);
    const data = new Date(Date.UTC(ano, mes - 1, dia));
    const existe =
      data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia;
    return existe ? { ok: true, valor: texto } : { ok: false, motivo: "valor_invalido" };
  }

  if (tipo === "number" || tipo === "currency") {
    // Número LIMPO: o modelo que lê "R$ 1.234,56" no voucher manda o texto cru,
    // e gravar texto em coluna numérica faria o relatório somar lixo. Sai o que
    // não é número nas pontas (símbolo de moeda, "R$", "USD"), e o resto é o
    // formato do voucher: ponto de milhar e VÍRGULA decimal ("1.234,56" →
    // 1234.56; "1234.56" → 1234.56). O que sobrar não ser número vira recusa e a
    // pessoa corrige na revisão — esta régua valida forma, não veracidade.
    const limpo = texto.replace(/^[^\d.,-]+|[^\d.,-]+$/g, "").replace(/\s/g, "");
    if (limpo === "") return { ok: false, motivo: "valor_invalido" };
    const n = Number(limpo.replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
    if (!Number.isFinite(n)) return { ok: false, motivo: "valor_invalido" };
    return { ok: true, valor: n };
  }

  if (tipo === "boolean") {
    const t = texto.toLowerCase();
    if (["true", "sim", "s", "1", "verdadeiro", "yes"].includes(t)) return { ok: true, valor: true };
    if (["false", "não", "nao", "n", "0", "falso", "no"].includes(t)) return { ok: true, valor: false };
    return { ok: false, motivo: "valor_invalido" };
  }

  if (tipo === "email") {
    // MESMO critério do CHECK `contacts_email_format` (irmã de contatos): o
    // voucher de contato traz o e-mail do passageiro, e divergir da outra porta
    // faria a proposta ser aceita aqui e recusada na gravação.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(texto)
      ? { ok: true, valor: texto }
      : { ok: false, motivo: "valor_invalido" };
  }

  if (tipo === "phone") {
    const digitos = texto.replace(/\D/g, "");
    return digitos.length >= 8 && digitos.length <= 15
      ? { ok: true, valor: texto }
      : { ok: false, motivo: "valor_invalido" };
  }

  if (tipo === "url") {
    return /^https?:\/\/\S+$/.test(texto)
      ? { ok: true, valor: texto }
      : { ok: false, motivo: "valor_invalido" };
  }

  if (tipo === "file") {
    // O arquivo NÃO é valor de texto: o documento já é anexo do negócio
    // (`crm_lead_attachments`), e gravar caminho de Storage num campo de texto
    // entregaria ao agente um caminho interno que ele não pode abrir.
    return { ok: false, motivo: "valor_invalido" };
  }

  // text / textarea: texto aparado, com um teto que cabe num jsonb sem virar
  // depósito de documento — o documento inteiro continua sendo o ANEXO.
  return { ok: true, valor: texto };
}

/** `a, b, c` de um multiselect lido no documento — vírgula, o separador do voucher. */
function splitItens(texto: string, tipo: CustomFieldDef["type"]): string[] {
  if (tipo !== "multiselect") return [texto];
  return texto
    .split(",")
    .map((i) => i.trim())
    .filter((i) => i.length > 0);
}

/**
 * O veredito de UM campo lido — forma (tipo), lista e `padrao`, nesta ordem.
 *
 * Exportada porque a CONFIRMAÇÃO humana a re-roda: entre a proposta nascer e o
 * humano confirmar, o dono pode ter trocado a lista ou o `padrao` do funil, e o
 * valor que a máquina leu de repente não cabe mais. Quem grava é a porta de
 * edição com a MESMA régua; aqui a mesma conta serve de triagem na fila e de
 * re-conferência na confirmação — uma conta só, como o resto da casa.
 */
export function confereCampoLido(
  campo: CustomFieldDef,
  valorBruto: string | number,
  testa = testaComPrazo,
): { ok: true; valor: unknown } | { ok: false; motivo: MotivoSemPropostaDeCampo } {
  // A proposta já guarda número em jsonb. Na confirmação, convertê-lo de
  // novo pelo leitor de texto regional fazia 1.234 virar 1234. A correção
  // digitada continua string; o número persistido conserva a escala e passa
  // pelo MESMO padrão atual do funil abaixo.
  const forma: ReturnType<typeof valorDoTipoAceitavel> =
    typeof valorBruto === "number" && (campo.type === "number" || campo.type === "currency")
      ? Number.isFinite(valorBruto)
        ? { ok: true, valor: valorBruto }
        : { ok: false, motivo: "valor_invalido" }
      : valorDoTipoAceitavel(campo, String(valorBruto));
  if (!forma.ok) return forma;
  const veredito = validaPadraoDoCampo(campo, forma.valor, testa);
  if (!veredito.ok) return { ok: false, motivo: veredito.motivo };
  return forma;
}

/** O `custom_fields` do negócio como record tolerante — lixo vira objeto vazio. */
function camposGravados(customFields: unknown): Record<string, unknown> {
  return customFields && typeof customFields === "object" && !Array.isArray(customFields)
    ? (customFields as Record<string, unknown>)
    : {};
}

/** Comparação que ignora aparas e caixa de número/booleano gravado em jsonb. */
function mesmoValor(atual: unknown, proposto: unknown): boolean {
  if (typeof atual === "string" && typeof proposto === "string") return atual.trim() === proposto.trim();
  return atual === proposto;
}

// ---------------------------------------------------------------------------
// O NASCIMENTO DA PROPOSTA — a fila, nunca o card
// ---------------------------------------------------------------------------

export interface DadosDaPropostaDeCampos {
  organizationId: string;
  leadId: string;
  /** O que o modelo leu do documento, campo a campo. */
  campos: readonly CampoLidoNoDocumento[];
  /**
   * O documento ANEXADO AO NEGÓCIO de onde vieram os valores
   * (`crm_lead_attachments.id`), quando houver — o que a pessoa abre para
   * conferir. Opcional porque o modelo também lê um documento que ainda não foi
   * anexado (escolhido da conversa); nesse caso a proposta nasce sem ponte e o
   * trecho continua obrigatório.
   */
  attachmentId?: string | null;
  /** O agente que leu o documento — autoria da proposta (`ai_agents.id`). */
  agentId?: string | null;
  /** De qual conversa veio o documento, quando veio de uma. */
  conversationId?: string | null;
  /** Dias até vencer. Mesma razão da irmã: proposta sem prazo vira badge eterna. */
  diasDePrazo?: number;
}

export interface ResultadoDoLoteDeCampos {
  /** As propostas que nasceram, na ordem pedida. */
  criadas: Array<{ id: string; campo: string; valorProposto: unknown; valorAnterior: unknown }>;
  /** As recusas, cada uma com o motivo — é o que a ferramenta devolve ao modelo. */
  recusadas: RecusaDeCampoLido[];
}

interface DefinicoesDoFunil {
  /** Todos os campos declarados (qualquer escopo) — para distinguir "fora" de "do contato". */
  todos: CustomFieldDef[];
  /** Só os do NEGÓCIO — os que moram em `crm_leads.custom_fields`. */
  doNegocio: CustomFieldDef[];
}

/**
 * Registra as propostas de UM documento. **Não grava em `crm_leads.custom_fields`**
 * — esse é o ponto. Uma proposta por campo, com `valor_anterior` capturado no
 * nascimento (o `from` que a decisão humana exige: quem confirma vê os dois
 * lados, e não precisa confiar que o valor ainda estará lá depois).
 */
export async function proporCamposDoNegocio(
  db: SupabaseClient,
  dados: DadosDaPropostaDeCampos,
): Promise<ResultadoDoLoteDeCampos> {
  const r: ResultadoDoLoteDeCampos = { criadas: [], recusadas: [] };
  if (dados.campos.length === 0) return r;

  const { data: lead, error: erroLead } = await db
    .from("crm_leads")
    .select("id, pipeline_id, custom_fields")
    .eq("organization_id", dados.organizationId)
    .eq("id", dados.leadId)
    .maybeSingle();

  if (erroLead) {
    for (const c of dados.campos) r.recusadas.push({ campo: c.campo, motivo: "negocio_nao_encontrado" });
    return r;
  }
  if (!lead) {
    for (const c of dados.campos) r.recusadas.push({ campo: c.campo, motivo: "negocio_nao_encontrado" });
    return r;
  }

  const settings = await settingsDoFunil(db, (lead as { pipeline_id?: string | null }).pipeline_id);
  if (settings === null) {
    // Funil ilegível (sem linha, sem settings): fail-open da casa, igual a
    // `settingsDoFunil` — sem definição não há o que cobrar, e a recusa é o
    // motivo HONESTO (`funil_sem_campos`), não "campo fora do funil": o campo
    // pode muito bem estar declarado; quem não leu foi esta chamada.
    for (const c of dados.campos) r.recusadas.push({ campo: c.campo.trim(), motivo: "funil_sem_campos" });
    return r;
  }
  const definicoes = definicoesDoFunil(settings);
  const gravados = camposGravados((lead as { custom_fields?: unknown }).custom_fields);

  // A mesma chave duas vezes no MESMO lote: a primeira vence. Sem isto, o
  // índice único parcial viraria a segunda recusa — e o modelo receberia
  // "já existe proposta" para uma proposta que ele mesmo acabou de criar.
  const vistas = new Set<string>();

  for (const lido of dados.campos) {
    const chave = lido.campo.trim();
    if (vistas.has(chave)) {
      r.recusadas.push({ campo: chave, motivo: "ja_existe_proposta" });
      continue;
    }
    vistas.add(chave);

    const def = definicoes.doNegocio.find((c) => c.key === chave);
    if (!def) {
      // Declarado como campo do CONTATO (#2791) é recusa com o motivo PRÓPRIO:
      // ele existe, mas o valor mora noutra coluna, e dizer "fora do funil" ao
      // modelo o faria perguntar ao dono por um campo que já existe.
      const ehDoContato = definicoes.todos.some((c) => c.key === chave);
      r.recusadas.push({ campo: chave, motivo: ehDoContato ? "campo_do_contato" : "campo_fora_do_funil" });
      continue;
    }

    // SEM TRECHO A PROPOSTA NÃO NASCE: a tela mostra "atual × proposto × de
    // onde veio", e a última coluna é o que permite conferir em vez de acreditar.
    if (!lido.trecho || lido.trecho.trim() === "") {
      r.recusadas.push({ campo: chave, motivo: "sem_trecho" });
      continue;
    }

    const veredito = confereCampoLido(def, lido.valor);
    if (!veredito.ok) {
      r.recusadas.push({ campo: chave, motivo: veredito.motivo });
      continue;
    }

    const valorAnterior = gravados[chave] ?? null;
    if (mesmoValor(valorAnterior, veredito.valor)) {
      r.recusadas.push({ campo: chave, motivo: "valor_igual_ao_atual" });
      continue;
    }

    const expiraEm = new Date(
      Date.now() + (dados.diasDePrazo ?? PRAZO_PADRAO_DIAS) * 24 * 3600_000,
    ).toISOString();

    // O trecho vai para a linha já aparado e cortado: a coluna é a prova que a
    // revisão exibe, e 500 é o teto do documento por campo. Em `const` porque o
    // narrowing do `if` acima não atravessa a closure de `nasceProposta`.
    const trecho = lido.trecho.trim().slice(0, 500);

    /**
     * O insert, numa função porque ele pode rodar DUAS vezes: a segunda acontece
     * quando a linha que estava na frente (o 23505) era uma proposta VENCIDA.
     */
    const nasceProposta = () =>
      db
        .from("lead_field_proposals")
        .insert({
          organization_id: dados.organizationId,
          lead_id: dados.leadId,
          campo: chave,
          valor_proposto: veredito.valor,
          valor_anterior: valorAnterior,
          trecho,
          attachment_id: dados.attachmentId ?? null,
          proposed_by_agent_id: dados.agentId ?? null,
          conversation_id: dados.conversationId ?? null,
          expires_at: expiraEm,
        })
        .select("id")
        .single();

    let { data: criada, error } = await nasceProposta();

    // ⚠️ O 23505 PODE SER UMA PROPOSTA VENCIDA — e aí ele NÃO é idempotência.
    //
    // O índice único parcial é `where status = 'pending'`, e uma proposta
    // vencida continua com `status = 'pending'` até alguém varrê-la. Sem este
    // ramo, o voucher relido no dia seguinte ao vencimento recebia
    // "ja_existe_proposta" para sempre: a linha morta bloqueava a nova, e a
    // pessoa via uma fila que nunca nascia. `expires_at` passa a valer na
    // ESCRITA também — vencida é encerrada aqui, na hora, e o insert é repetido.
    if (error && (error as { code?: string }).code === "23505") {
      const liberou = await encerraVencidaDoCampo(db, dados, chave, new Date());
      if (liberou) ({ data: criada, error } = await nasceProposta());
    }

    if (error) {
      // 23505 restante = o índice único parcial (org, lead, campo) WHERE pending.
      // Não é falha: é a idempotência funcionando — o mesmo voucher relido em dez
      // turnos não enche a fila de revisão de repetições.
      if ((error as { code?: string }).code === "23505") {
        r.recusadas.push({ campo: chave, motivo: "ja_existe_proposta" });
        continue;
      }
      // Erro de banco não vira proposta silenciosa: o motivo é o do negócio,
      // e o detalhe fica fora daqui (o chamador loga; o modelo vê o motivo).
      r.recusadas.push({ campo: chave, motivo: "negocio_nao_encontrado" });
      continue;
    }

    r.criadas.push({
      id: (criada as { id: string }).id,
      campo: chave,
      valorProposto: veredito.valor,
      valorAnterior,
    });
  }

  return r;
}

/** As definições do funil nos DOIS recortes que a triagem pergunta. */
function definicoesDoFunil(settings: unknown): DefinicoesDoFunil {
  const todos = camposDoFunil(
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : null,
  );
  return { todos, doNegocio: camposPorEscopo(todos, "negocio") };
}

// ---------------------------------------------------------------------------
// ⏳ A EXPIRAÇÃO — o prazo que EXISTE, em vez do prazo que só está escrito
// ---------------------------------------------------------------------------
//
// ═══ O DEFEITO QUE ESTE BLOCO FECHA ═══
//
// `expires_at` nasceu obrigatório na 0772, com o argumento certo ("proposta que
// ninguém decide vira badge permanente, que simula atenção e adia a decisão") —
// e ficou sem NENHUM consumidor: nem a leitura da fila, nem a decisão, nem
// varredura. Uma coluna de prazo que ninguém cobra é pior que prazo nenhum:
// promete um limite que não existe, e a proposta vencida continuava elegível,
// continuava aparecendo na tela e continuava bloqueando (índice único parcial)
// a proposta nova do mesmo campo. O mantenedor mediu exatamente isso no #3415.
//
// Três consumidores, um por lugar onde a pergunta "isto ainda vale?" é feita:
//
//   1. a LEITURA da fila (`GET .../field-proposals`) filtra por `expires_at`;
//   2. a DECISÃO (`POST .../field-proposals/[pid]`) recusa decidir vencida;
//   3. o NASCIMENTO (`proporCamposDoNegocio`) encerra a vencida que estiver
//      bloqueando o índice parcial — via `encerraVencidaDoCampo`, abaixo;
//   4. a VARREDURA (`vencePropostasDeCampo`), chamada pelo cron que já vence as
//      propostas de dado do contato: sem ela, a linha vencida ficaria `pending`
//      para sempre e a fila teria de filtrar prazo em toda leitura, sem nunca
//      encerrar nada.

/** O prazo de uma proposta, comparado com o relógio do SERVIDOR. */
export function propostaVencida(
  proposta: { expires_at?: string | null },
  agora: Date = new Date(),
): boolean {
  if (!proposta.expires_at) return false;
  const quando = Date.parse(proposta.expires_at);
  // Data ilegível não é "vencida": é registro estragado, e encerrar por causa
  // de um `NaN` apagaria trabalho pendente por um erro de formatação.
  if (!Number.isFinite(quando)) return false;
  return quando <= agora.getTime();
}

/**
 * Encerra a proposta PENDENTE e vencida de UM campo, se for o caso.
 *
 * Chamada só no caminho de colisão (23505) do nascimento: é ali que a linha
 * vencida aparece como bloqueio. A leitura e o UPDATE são condicionais a
 * `status = 'pending'` — a mesma trava da decisão humana, do outro lado da
 * corrida: quem decide no mesmo instante vence, e esta função não atropela.
 *
 * Devolve `true` quando ENCERROU algo (o chamador pode repetir o insert).
 */
export async function encerraVencidaDoCampo(
  db: SupabaseClient,
  dados: Pick<DadosDaPropostaDeCampos, "organizationId" | "leadId">,
  campo: string,
  agora: Date,
): Promise<boolean> {
  const { data: viva, error } = await db
    .from("lead_field_proposals")
    .select("id, expires_at, status")
    .eq("organization_id", dados.organizationId)
    .eq("lead_id", dados.leadId)
    .eq("campo", campo)
    .eq("status", "pending")
    .maybeSingle();

  if (error || !viva) return false;
  const linha = viva as { id: string; expires_at?: string | null; status?: string };
  if (linha.status !== "pending" || !propostaVencida(linha, agora)) return false;

  const { data: encerrada } = await db
    .from("lead_field_proposals")
    .update({ status: "expired", decided_at: agora.toISOString() })
    .eq("id", linha.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  return Boolean(encerrada);
}

export interface ResultadoDoVencimentoDeCampos {
  vencidas: number;
}

/**
 * A VARREDURA: encerra as propostas de campo do CARD que ninguém decidiu.
 *
 * Uma organização por chamada, como a irmã de contatos: o cron lista quem TEM
 * proposta vencida e chama isto por organização, em vez de varrer o banco
 * inteiro por tenant numa consulta só sem tenancy.
 *
 * `decided_at` recebe o instante da VARREDURA, não o do vencimento: é quando o
 * sistema encerrou, e é isso que a auditoria pergunta. O prazo que venceu
 * continua legível em `expires_at`.
 */
export async function vencePropostasDeCampo(
  db: SupabaseClient,
  organizationId: string,
  agora: Date,
): Promise<ResultadoDoVencimentoDeCampos> {
  const { data, error } = await db
    .from("lead_field_proposals")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .lt("expires_at", agora.toISOString());

  if (error) throw new Error(`vencimento de proposta de campo: ${error.message}`);

  const vencidas = (data ?? []) as Array<{ id: string }>;
  let encerradas = 0;

  for (const p of vencidas) {
    const { error: erroUpdate } = await db
      .from("lead_field_proposals")
      .update({ status: "expired", decided_at: agora.toISOString() })
      .eq("id", p.id)
      // Não atropela quem decidiu no MESMO instante: o `pending` no WHERE é a
      // mesma trava que a rota de decisão usa, do outro lado da corrida.
      .eq("status", "pending");
    if (erroUpdate) continue;
    encerradas += 1;
  }

  return { vencidas: encerradas };
}

