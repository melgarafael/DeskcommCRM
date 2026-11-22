/**
 * Evidências já consultadas pelo servidor NESTE turno. Não são uma lista de
 * exceções: o classificador continua lendo a candidata inteira e suas condições.
 * Não recebe histórico, prompt do agente ou argumentos de tool. A origem
 * `servidor_externo` é a exceção sobre dado do contato: o sistema de terceiro
 * devolve o registro dele, e por isso o conteúdo passa pela redação de dado
 * pessoal (`anonymize`) antes de ser guardado.
 */
export interface EvidenciaComercial {
  origem: OrigemDaEvidencia;
  referencia: string;
  titulo: string;
  conteudo: string;
}

/**
 * `servidor_externo`: resultado de uma ferramenta do servidor MCP externo
 * montada como LEITURA (`category: "read"` de `definirFerramentasRemotas`). É
 * o sistema da empresa — a agenda, o pedido — consultado com a identidade do
 * contato da conversa. Sustenta RELATAR o que ele registra (data, horário,
 * situação); é registro consultado, nunca instrução nem política comercial, e
 * não entra no material da organização (`materialDaOrganizacao`).
 */
export type OrigemDaEvidencia = "catalogo" | "conhecimento" | "servidor_externo";

const ORIGENS: readonly OrigemDaEvidencia[] = ["conhecimento", "catalogo", "servidor_externo"];

import { anonymize } from "@/lib/ai/anonymize";
import { canonizarTipoDeFonte, type TipoDeFonteId } from "@/lib/ai/rag/tipos-de-fonte";
import type { Queryable } from "../../queue/queue";

/**
 * Lista de PERMISSÃO, não de bloqueio: "Conversas anteriores" guarda o que o
 * CLIENTE escreveu, e um cliente não autoriza oferta. Tipo legado é canonizado
 * antes (`conversations` vira `conversas`), e tipo desconhecido fica de fora.
 */
const TIPOS_QUE_PROVAM_OFERTA: ReadonlySet<TipoDeFonteId> = new Set([
  "faq",
  "documento",
  "catalogo",
]);

export function fontesQueProvamOferta(
  fontes: readonly { id: string; source_type: string }[],
): string[] {
  return fontes
    .filter((f) => {
      const tipo = canonizarTipoDeFonte(f.source_type);
      return tipo !== null && TIPOS_QUE_PROVAM_OFERTA.has(tipo);
    })
    .map((f) => f.id);
}

/** Fontes do agente que podem provar oferta. Org da linha do job, nunca do modelo. */
export async function carregarFontesQueProvamOferta(
  db: Queryable,
  tenantId: string,
  fontesDoAgente: readonly string[],
): Promise<string[]> {
  if (fontesDoAgente.length === 0) return [];
  const { rows } = await db.query<{ id: string; source_type: string }>(
    "select id::text as id, source_type from ai_knowledge_sources where organization_id = $1 and id = any($2::uuid[])",
    [tenantId, fontesDoAgente],
  );
  return fontesQueProvamOferta(rows);
}

const MAX_EVIDENCIAS = 20;
const MAX_CARACTERES = 16_000;
const MAX_POR_EVIDENCIA = 4_000;
// O orçamento enviado ao revisor é menor que o acervo do turno. Um catálogo
// amplo não deve eliminar a política antes de sabermos o que será afirmado.
const MAX_ACERVO_POR_ORIGEM = 100;
const MAX_CARACTERES_POR_ORIGEM = 100_000;

function termos(value: string): Set<string> {
  return new Set(
    (
      value
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .match(/[a-z0-9]+(?:[.,][0-9]+)?/g) ?? []
    )
      .filter((t) => t.length >= 2)
      .map((t) => t.replace(",", ".")),
  );
}

function objeto(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function texto(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * O objeto de topo de um resultado de ferramenta: objeto, JSON em string ou o
 * `content[].text` que a ponte MCP devolve. A mesma leitura de
 * `guardrails/horario-da-agenda.ts` — aqui, porque a evidência precisa do
 * payload e não do envelope.
 */
function objetoDoResultado(resultado: unknown): Record<string, unknown> | null {
  let r: unknown = resultado;
  if (typeof r === "string") {
    try {
      r = JSON.parse(r);
    } catch {
      return null;
    }
  }
  if (r === null || typeof r !== "object" || Array.isArray(r)) return null;
  const conteudo = (r as { content?: unknown }).content;
  if (Array.isArray(conteudo)) {
    const achado = conteudo.find(
      (c): c is { text: string } => typeof (c as { text?: unknown } | null)?.text === "string",
    );
    return achado ? objetoDoResultado(achado.text) : null;
  }
  return r as Record<string, unknown>;
}

/**
 * "90 minutos" não é como a pessoa fala, e o modelo repassa o que recebe: a
 * evidência escreve as duas formas para a paráfrase ("a consulta dura 1h30")
 * ser comparação de igual para igual, não conta de cabeça.
 */
function rotuloDeDuracao(minutos: number): string {
  if (minutos <= 0) return "duração não informada";
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  const falado = h === 0 ? `${m}min` : m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
  return `duração ${minutos} minutos (${falado})`;
}

export function criarEvidenciasComerciaisDoTurno(fontesHabilitadas: readonly string[]) {
  const fontes = new Set(fontesHabilitadas);
  const evidencias = new Map<string, EvidenciaComercial>();

  /** `false` quando a evidência passa do teto e fica de fora. */
  function guardar(evidencia: EvidenciaComercial): boolean {
    const chave = `${evidencia.origem}:${evidencia.referencia}`;
    evidencias.delete(chave);
    // Nunca cortar uma frase: a ressalva no fim pode mudar toda a autorização.
    if (JSON.stringify(evidencia).length > MAX_POR_EVIDENCIA) return false;
    evidencias.set(chave, evidencia);
    const daOrigem = () =>
      [...evidencias.entries()].filter(([, e]) => e.origem === evidencia.origem);
    while (
      daOrigem().length > MAX_ACERVO_POR_ORIGEM ||
      JSON.stringify(daOrigem().map(([, e]) => e)).length > MAX_CARACTERES_POR_ORIGEM
    ) {
      const primeira = daOrigem()[0]?.[0];
      if (primeira === undefined) break;
      evidencias.delete(primeira);
    }
    return true;
  }

  function registrarConhecimento(resultado: unknown) {
    const r = objeto(resultado);
    if (!r || r.error || r.erro || r.ok === false) return;
    const trechos = r.results ?? r.trechos;
    if (!Array.isArray(trechos)) return;
    for (const item of trechos) {
      const t = objeto(item);
      if (!t) continue;
      const fonte = texto(t.knowledge_source_id);
      const id = texto(t.chunk_id);
      const conteudo = texto(t.content);
      // Nem outro agente, nem o índice legado sem fonte identificável autorizam
      // uma oferta aqui. A consulta original continua disponível ao Conversador.
      if (!fonte || !fontes.has(fonte) || !id || !conteudo) continue;
      guardar({
        origem: "conhecimento",
        referencia: `${fonte}:${id}`,
        titulo: texto(t.source_name) ?? "Material habilitado para o agente",
        conteudo,
      });
    }
  }

  /** Apenas retornos bem-sucedidos da busca de produtos ativos da organização. */
  function registrarCatalogo(resultado: unknown) {
    const r = objeto(resultado);
    if (!r || r.error || r.erro || r.ok === false || !Array.isArray(r.produtos)) return;
    for (const item of r.produtos) {
      const p = objeto(item);
      if (!p) continue;
      const codigo = texto(p.codigo);
      const nome = texto(p.nome);
      const descricao = texto(p.descricao);
      const preco = texto(p.preco);
      // O bloco `servico` (módulo catálogo de serviços, #3480) é oferta do
      // catálogo também: variações, sinal, prazo e "Grátis" que a busca entregou
      // são o que a resposta certa vai dizer, e sem eles na evidência a guarda
      // vetaria a frase verdadeira. As instruções internas NÃO entram: orientam
      // o agente e nunca são oferta.
      const servico = objeto(p.servico);
      if (!codigo || !nome || (!descricao && !servico) || !preco || p.disponivel !== true) continue;
      const ofertaDoServico = servico
        ? Object.fromEntries(
            Object.entries(servico).filter(([k]) => k !== "instrucoes_internas_nao_repita_ao_cliente"),
          )
        : null;
      guardar({
        origem: "catalogo",
        referencia: codigo,
        titulo: nome,
        conteudo: JSON.stringify({
          nome,
          preco,
          ...(descricao ? { descricao } : {}),
          ...(ofertaDoServico ? { servico: ofertaDoServico } : {}),
        }),
      });
    }
  }

  let consultasRemotas = 0;
  /** Consultas de AGENDA do turno — numera as referências como as remotas. */
  let consultasDeAgenda = 0;

  /**
   * Só retornos bem-sucedidos (`{ texto, dados? }` de `definirFerramentasRemotas`).
   * Erro do servidor, recusa de escopo e resultado vazio não viram evidência.
   * `dados` em lista vira uma evidência por item: a agenda com vários horários
   * não cai inteira no teto de uma evidência. Item acima do teto é descartado
   * inteiro, como nas outras origens (cortar poderia esconder a ressalva do
   * fim), e o tamanho de cada descarte volta a quem chamou, para o log do turno.
   */
  function registrarLeituraRemota(nome: string, resultado: unknown): number[] {
    const r = objeto(resultado);
    if (!r || r.error || r.erro || r.ok === false || r.permitido === false) return [];
    const temDados = r.dados !== undefined && r.dados !== null;
    const partes = !temDados ? [r.texto] : Array.isArray(r.dados) ? r.dados : [r.dados];
    consultasRemotas += 1;
    const descartadas: number[] = [];
    partes.forEach((parte, i) => {
      const bruto =
        typeof parte === "string" ? texto(parte) : parte == null ? null : JSON.stringify(parte);
      if (!bruto) return;
      const evidencia: EvidenciaComercial = {
        origem: "servidor_externo",
        referencia: `${nome}:${consultasRemotas}${partes.length > 1 ? `.${i + 1}` : ""}`,
        titulo: `Consulta ao sistema externo: ${nome}`,
        conteudo: anonymize(bruto).anonymized,
      };
      if (!guardar(evidencia)) descartadas.push(JSON.stringify(evidencia).length);
    });
    return descartadas;
  }

  /**
   * O que uma tool de AGENDA devolveu: `horarios[]` de `crm_find_free_slots` (e da
   * conjunta que consulta e marca) ou `tipos[]` de `crm_list_event_types`.
   *
   * É o sistema da empresa respondendo ao turno, e entra na MESMA origem
   * `servidor_externo` — sustenta relatar data, horário, duração e situação do que
   * ela registra, nunca condição comercial. Sem isto, a lista que o modelo copiou
   * da ferramenta chegava à conferência sem lastro nenhum e caía em "confirma vaga
   * sem comprovação": o turno era vetado até sobrar uma frase vaga, sem data e sem
   * horário (#4927). O veto não muda — muda a evidência existir.
   *
   * Um item por horário/tipo: a lista inteira num só item bateria no teto e
   * sumiria calada. O preço do tipo fica FORA de propósito: a origem
   * `servidor_externo` não autoriza oferta, e mandá-lo convidaria o revisor a ler
   * como política comercial o que é só o cadastro do atendimento.
   */
  function registrarConsultaDeAgenda(nome: string, resultado: unknown): number[] {
    const r = objetoDoResultado(resultado);
    if (!r || r.error || r.erro || r.ok === false || r.permitido === false) return [];
    // ESCRITA já tem comprovante próprio (`bookingEvidence`, lido do banco): a
    // reserva gravada não é uma segunda prova da lista de horários.
    if (r.marcado === true || r.remarcado === true) return [];
    const horarios = Array.isArray(r.horarios) ? r.horarios : [];
    const tipos = Array.isArray(r.tipos) ? r.tipos : [];
    const consultaConhecida =
      horarios.length > 0 ||
      tipos.length > 0 ||
      typeof r.publicou_horarios === "boolean" ||
      texto(r.fuso_da_regra) !== null;
    if (!consultaConhecida) return [];

    consultasDeAgenda += 1;
    const descartadas: number[] = [];
    const guardarOuDescartar = (evidencia: EvidenciaComercial) => {
      if (!guardar(evidencia)) descartadas.push(JSON.stringify(evidencia).length);
    };
    // Cabeçalho: de ONDE veio a lista e o que ela cobre. `publicou_horarios:false`
    // e `agenda_externa_nunca_lida:true` são ressalvas do REGISTRO — o revisor já
    // sabe lê-las, e omiti-las faria uma lista incompleta parecer completa.
    guardarOuDescartar({
      origem: "servidor_externo",
      referencia: `${nome}:${consultasDeAgenda}`,
      titulo: `Consulta à agenda: ${nome}`,
      conteudo: JSON.stringify({
        consulta: nome,
        ...(texto(r.fuso_da_regra) !== null ? { fuso: texto(r.fuso_da_regra) } : {}),
        ...(typeof r.total_de_horarios === "number"
          ? { total_de_horarios: r.total_de_horarios }
          : {}),
        ...(r.ha_mais === true ? { lista_cortada: true } : {}),
        ...(r.publicou_horarios === false ? { publicou_horarios: false } : {}),
        ...(r.agenda_externa_nunca_lida === true ? { agenda_externa_nunca_lida: true } : {}),
        ...(r.fuso_suposto === true ? { fuso_suposto: true } : {}),
      }),
    });
    horarios.forEach((h, i) => {
      const item = objeto(h);
      if (!item || item.disponivel === false) return;
      const quando = texto(item.quando);
      const inicio = texto(item.inicio);
      if (!quando && !inicio) return;
      const fim = texto(item.fim);
      guardarOuDescartar({
        origem: "servidor_externo",
        referencia: `${nome}:${consultasDeAgenda}.${i + 1}`,
        titulo: `Horário livre na agenda: ${quando ?? inicio}`,
        conteudo:
          `Horário livre devolvido pela agenda: ${quando ?? inicio}` +
          (inicio !== null ? ` (início ${inicio}${fim !== null ? `, fim ${fim}` : ""})` : "") +
          ".",
      });
    });
    tipos.forEach((t, i) => {
      const item = objeto(t);
      if (!item) return;
      const rotulo = texto(item.nome) ?? texto(item.slug);
      if (!rotulo) return;
      const slug = texto(item.slug);
      const duracao = typeof item.duracao_minutos === "number" ? item.duracao_minutos : null;
      const onde = texto(item.onde);
      guardarOuDescartar({
        origem: "servidor_externo",
        referencia: `${nome}:${consultasDeAgenda}.t${i + 1}`,
        titulo: `Atendimento cadastrado: ${rotulo}`,
        conteudo:
          `Atendimento "${rotulo}"` +
          (slug !== null ? ` (slug ${slug})` : "") +
          (duracao !== null ? `, ${rotuloDeDuracao(duracao)}` : "") +
          (onde !== null ? `, ${onde}` : "") +
          (item.precisa_confirmacao === true ? ", depende de confirmação da equipe" : "") +
          ".",
      });
    });
    return descartadas;
  }

  return {
    registrarConhecimento,
    registrarCatalogo,
    registrarLeituraRemota,
    registrarConsultaDeAgenda,
    // Relevância escolhe o CONTEXTO, nunca concede autorização. O classificador
    // recebe os trechos completos, inclusive condições/negações, e decide.
    ler: (candidata = ""): EvidenciaComercial[] => {
      const consulta = termos(candidata);
      const acervo = [...evidencias.values()].map((e, ordem) => ({
        e,
        ordem,
        palavras: termos(`${e.titulo} ${e.conteudo}`),
      }));
      const frequencias = new Map<string, number>();
      for (const { palavras } of acervo)
        for (const palavra of palavras)
          frequencias.set(palavra, (frequencias.get(palavra) ?? 0) + 1);
      const ordenadas = acervo
        .map((item) => ({
          ...item,
          pontos: [...consulta].reduce(
            (n, t) => n + (item.palavras.has(t) ? 1 / (frequencias.get(t) ?? 1) : 0),
            0,
          ),
        }))
        .sort((a, b) => b.pontos - a.pontos || b.ordem - a.ordem);
      const escolhidas: EvidenciaComercial[] = [];
      const usadas = new Set<EvidenciaComercial>();
      function adicionar(e: EvidenciaComercial) {
        if (usadas.has(e) || escolhidas.length >= MAX_EVIDENCIAS) return;
        if (JSON.stringify([...escolhidas, e]).length > MAX_CARACTERES) return;
        escolhidas.push(e);
        usadas.add(e);
      }
      // Reserva mínima para cada origem: política e produto complementam-se.
      // O restante segue a relevância global, sem duplicar ou truncar itens.
      for (let i = 0; i < 3; i++)
        for (const origem of ORIGENS) {
          const item = ordenadas.filter(({ e }) => e.origem === origem)[i];
          if (item) adicionar(item.e);
        }
      for (const { e } of ordenadas) adicionar(e);
      return escolhidas.map((e) => ({ ...e }));
    },
    // Inclui também itens fora do pacote selecionado: uma consulta pode mudar
    // qual item é pertinente à mesma candidata. Usado só no memo do turno.
    contexto: (): string => JSON.stringify([...evidencias.values()]),
    // O que a ORGANIZAÇÃO escreveu ou cadastrou, para o lastro de concessão. O
    // registro do servidor externo fica fora: ele relata, não autoriza.
    materialDaOrganizacao: (): string =>
      JSON.stringify([...evidencias.values()].filter((e) => e.origem !== "servidor_externo")),
  };
}
