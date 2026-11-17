/**
 * OS ANEXOS DE UM NEGÓCIO — LISTAR E LER (#4544, item 2).
 *
 * ─── O defeito que este arquivo fecha ───────────────────────────────────────
 *
 * `crm_propose_lead_fields_from_document` já aceitava `attachment_id`, mas um
 * agente que roda pelo MCP não tinha como DESCOBRIR esse id nem LER o conteúdo
 * do PDF. Na prática: a apólice estava anexada no card, e o card continuava sem
 * o número da apólice — o único jeito era uma pessoa abrir o arquivo e digitar.
 *
 * ─── Um só caminho de leitura de arquivo ────────────────────────────────────
 *
 * A leitura daqui NÃO abre caminho próprio. Ela repete, passo a passo, o que a
 * rota de mídia do anexo já faz (`app/api/v1/leads/[id]/attachments/[attachmentId]/media/route.ts`):
 *
 *   1. o negócio precisa existir na ORGANIZAÇÃO de quem pede (mesma query);
 *   2. a linha em `crm_lead_attachments` é buscada por id + negócio + organização;
 *   3. `isLeadAttachmentPathOwnedBy` (`lib/messaging/media/upload-validation.ts`)
 *      confere que o objeto mora sob `{org}/leads/{lead}/` — um `storage_path`
 *      adulterado não vira leitura de arquivo alheio;
 *   4. os bytes saem de `internal-media` por `extrairTextoDoArquivo`
 *      (`lib/ai/rag/ingest/documento.ts`), a MESMA extração do acervo de
 *      conhecimento: um único leitor de PDF no produto (pdfjs-dist), nunca dois.
 *
 * ─── Escopo ─────────────────────────────────────────────────────────────────
 *
 * Quem não vê o negócio não vê o anexo. Três cercas, todas no BANCO, nunca na
 * boa-fé do chamador: `organization_id` nas duas queries; o contato do turno
 * (quando o turno atende alguém, só o negócio DESSE contato); e a posse do
 * caminho no Storage. Id de outra empresa, de outro cliente ou inexistente
 * recebem a MESMA recusa — um uuid não vira oráculo de existência.
 *
 * ─── Teto ───────────────────────────────────────────────────────────────────
 *
 * O arquivo tem o teto do upload (`TETO_DE_BYTES_DO_ANEXO`, 50 MB: é o limite
 * que a rota de anexos já impõe, e uma linha acima disso é corrupção, não uso).
 * O TEXTO entregue tem `TETO_DE_CARACTERES_DO_ANEXO` (24 000 caracteres, a
 * mesma régua de `ler_documento`) e volta PARCIAL com o motivo escrito — corte
 * mudo faria o modelo afirmar o que só estaria no fim do documento.
 *
 * ─── Imagem e binário ───────────────────────────────────────────────────────
 *
 * Não devolve base64 e não transcreve imagem: um voucher de 3 MB em base64
 * custa mais token do que o turno inteiro e o MCP não tem caminho de visão. A
 * resposta traz `conteudo: null`, `legivel_como_texto: false`, o motivo em
 * português e `caminho_da_midia` (a rota autenticada que a pessoa abre) — quem
 * lê o resultado sabe que precisa de gente, em vez de receber string vazia.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { resolverExtensao, extrairTextoDoArquivo } from "@/lib/ai/rag/ingest/documento";
import { caminhoDaMidiaDoAnexo } from "@/lib/kanban/anexos-no-card";
import { isLeadAttachmentPathOwnedBy } from "@/lib/messaging/media/upload-validation";
import { logger } from "@/lib/logger";

/** O bucket onde o anexo de campo do negócio mora (o mesmo do upload). */
export const BUCKET_DO_ANEXO_DO_NEGOCIO = "internal-media";

/** O teto de BYTES do arquivo — o mesmo que a rota de anexos impõe no upload. */
export const TETO_DE_BYTES_DO_ANEXO = 50 * 1024 * 1024;

/**
 * O teto de caracteres entregues por leitura — a MESMA régua de
 * `TETO_DE_CARACTERES_DO_DOCUMENTO` (`lib/agent-engine/agent/ler-documento.ts`):
 * ~6,8k tokens. Uma apólice de 40 páginas não cabe num turno de atendimento; o
 * que passa disso volta parcial e dizendo por quê.
 */
export const TETO_DE_CARACTERES_DO_ANEXO = 24_000;

/** A linha de `crm_lead_attachments` como a listagem e a leitura precisam dela. */
interface LinhaDoAnexo {
  id: string;
  lead_id: string;
  field_key: string | null;
  file_name: string;
  file_size: number | string | null;
  mime_type: string | null;
  created_at: string | null;
  storage_path?: string | null;
}

/** O anexo como o agente vê na listagem. */
export interface AnexoDoNegocio {
  id: string;
  lead_id: string;
  /** O campo `file` do funil onde o arquivo foi anexado (a chave, não o rótulo). */
  campo: string | null;
  nome: string;
  /** MIME gravado no upload (`application/pdf`, `image/jpeg`…). */
  tipo: string;
  tamanho_bytes: number;
  criado_em: string | null;
  /** A rota autenticada do arquivo — o mesmo link que o card usa. */
  caminho_da_midia: string;
}

/** O anexo lido: a listagem + o texto extraído (ou o motivo de não haver texto). */
export interface AnexoLido extends AnexoDoNegocio {
  /** Texto legível do documento; `null` quando é imagem/binário ou não há texto. */
  conteudo: string | null;
  /** A leitura NÃO cobriu o documento inteiro. */
  truncado: boolean;
  /** Por que não há texto (ou por que está incompleto). `null` = inteiro. */
  motivo: string | null;
  /** `true` só quando `conteudo` traz texto extraído de verdade. */
  legivel_como_texto: boolean;
}

export type CodigoDeRecusaDeAnexo =
  | "negocio_nao_encontrado"
  | "negocio_fora_da_conversa"
  | "anexo_nao_encontrado"
  | "anexo_grande_demais"
  | "internal_error";

export interface RecusaDeAnexo {
  ok: false;
  erro: {
    codigo: CodigoDeRecusaDeAnexo;
    /** Frase de gente — é o que o modelo lê e repete para o cliente. */
    mensagem: string;
  };
}

export type ListaDeAnexos = { ok: true; anexos: AnexoDoNegocio[] };
export type LeituraDeAnexo = { ok: true; anexo: AnexoLido };

export interface EscopoDoNegocio {
  organizationId: string;
  leadId: string;
  /**
   * O contato que o turno atende. Ausente nos ingressos de fora do turno (rota
   * MCP externa, automação) — e a ausência não amplia nada: a organização
   * continua valendo. Presente, só o negócio DESTE contato é visível.
   */
  contatoDoTurno?: string | null;
}

/**
 * A recusa de negócio é UMA só: inexistente, de outra organização ou de outro
 * cliente do turno respondem igual. Distinguir transformaria a ferramenta num
 * verificador de uuids.
 */
const NEGOCIO_INVISIVEL: RecusaDeAnexo = {
  ok: false,
  erro: {
    codigo: "negocio_nao_encontrado",
    mensagem:
      "não encontrei esse negócio nesta conta — confira o id do negócio; " +
      "não cite nem abra nada por um id que não veio da listagem.",
  },
};

const ANEXO_INVISIVEL: RecusaDeAnexo = {
  ok: false,
  erro: {
    codigo: "anexo_nao_encontrado",
    mensagem:
      "não há anexo com esse id neste negócio — use o id que a listagem de anexos devolveu.",
  },
};

const FORA_DA_CONVERSA: RecusaDeAnexo = {
  ok: false,
  erro: {
    codigo: "negocio_fora_da_conversa",
    mensagem:
      "esta conversa é com outra pessoa — um negócio que não é deste cliente não é seu para ver; " +
      "siga a conversa com quem está falando.",
  },
};

const FALHA_INTERNA: RecusaDeAnexo = {
  ok: false,
  erro: {
    codigo: "internal_error",
    mensagem: "não consegui ler os anexos deste negócio agora — siga com o que você já sabe e não invente.",
  },
};

/**
 * O negócio existe, é da organização de quem pede e está no escopo do turno?
 * A query é a MESMA da rota de mídia (`select id`, `id`, `organization_id`).
 */
async function negocioVisivel(
  db: SupabaseClient,
  escopo: EscopoDoNegocio,
): Promise<RecusaDeAnexo | null> {
  const { data: lead, error } = await db
    .from("crm_leads")
    .select("id, contact_id")
    .eq("id", escopo.leadId)
    .eq("organization_id", escopo.organizationId)
    .maybeSingle();

  if (error) {
    logger.error("[anexos-do-negocio] erro ao buscar negócio", {
      erro: error.message,
      lead_id: escopo.leadId,
    });
    return FALHA_INTERNA;
  }
  if (!lead) return NEGOCIO_INVISIVEL;

  const contato = (lead as { contact_id?: string | null }).contact_id ?? null;
  if (escopo.contatoDoTurno && contato !== escopo.contatoDoTurno) return FORA_DA_CONVERSA;

  return null;
}

function paraAnexo(row: LinhaDoAnexo, leadId: string): AnexoDoNegocio {
  return {
    id: row.id,
    lead_id: row.lead_id,
    campo: row.field_key ?? null,
    nome: row.file_name,
    tipo: row.mime_type ?? "",
    tamanho_bytes: Number(row.file_size) || 0,
    criado_em: row.created_at ?? null,
    caminho_da_midia: caminhoDaMidiaDoAnexo(leadId, row.id),
  };
}

/**
 * LISTA os anexos do negócio — id, nome, tipo, tamanho e data, na ordem em que
 * foram anexados (a mesma da rota e do card). `campo` filtra pelo campo `file`
 * do funil, como a rota faz com `field_key`.
 */
export async function listarAnexosDoNegocio(
  db: SupabaseClient,
  escopo: EscopoDoNegocio & { campo?: string | null },
): Promise<ListaDeAnexos | RecusaDeAnexo> {
  const recusa = await negocioVisivel(db, escopo);
  if (recusa) return recusa;

  let query = db
    .from("crm_lead_attachments")
    .select("id, lead_id, field_key, file_name, file_size, mime_type, created_at")
    .eq("lead_id", escopo.leadId)
    .eq("organization_id", escopo.organizationId)
    .order("created_at", { ascending: true });

  if (escopo.campo) query = query.eq("field_key", escopo.campo);

  const { data: rows, error } = await query;
  if (error) {
    logger.error("[anexos-do-negocio] erro ao listar anexos", {
      erro: error.message,
      lead_id: escopo.leadId,
    });
    return FALHA_INTERNA;
  }

  return {
    ok: true,
    anexos: ((rows ?? []) as LinhaDoAnexo[]).map((r) => paraAnexo(r, escopo.leadId)),
  };
}

export interface DependenciasDaLeituraDeAnexo {
  /** Injeção para teste: a extração real fala com o Storage. */
  extrair?: typeof extrairTextoDoArquivo;
}

/**
 * LÊ um anexo do negócio pelo id — o texto do documento quando ele é documento.
 *
 * A ordem das recusas é a da rota de mídia e não é arbitrária: primeiro o
 * NEGÓCIO (organização + escopo do turno), depois a LINHA do anexo presa ao
 * negócio e à organização, depois a POSSE do caminho. Só então o Storage é
 * tocado — nenhum byte sai antes das três cercas.
 */
export async function lerAnexoDoNegocio(
  db: SupabaseClient,
  escopo: EscopoDoNegocio & { attachmentId: string },
  deps: DependenciasDaLeituraDeAnexo = {},
): Promise<LeituraDeAnexo | RecusaDeAnexo> {
  const recusa = await negocioVisivel(db, escopo);
  if (recusa) return recusa;

  // Id do anexo, do negócio e da organização na MESMA cláusula: um id válido de
  // outro negócio não é encontrado aqui, então não vira oráculo nem vazamento.
  const { data: row, error } = await db
    .from("crm_lead_attachments")
    .select("id, lead_id, field_key, file_name, file_size, mime_type, created_at, storage_path")
    .eq("id", escopo.attachmentId)
    .eq("lead_id", escopo.leadId)
    .eq("organization_id", escopo.organizationId)
    .maybeSingle();

  if (error) {
    logger.error("[anexos-do-negocio] erro ao buscar anexo", {
      erro: error.message,
      attachment_id: escopo.attachmentId,
    });
    return FALHA_INTERNA;
  }
  if (!row) return ANEXO_INVISIVEL;

  const linha = row as LinhaDoAnexo;
  const anexo = paraAnexo(linha, escopo.leadId);

  // A posse do caminho é a mesma cerca da rota de mídia: o objeto tem de morar
  // sob `{org}/leads/{lead}/`. Caminho adulterado responde como inexistente.
  if (
    !linha.storage_path ||
    !isLeadAttachmentPathOwnedBy(linha.storage_path, escopo.organizationId, escopo.leadId)
  ) {
    logger.warn("[anexos-do-negocio] caminho fora do negócio; nada lido", {
      attachment_id: escopo.attachmentId,
    });
    return ANEXO_INVISIVEL;
  }

  if (anexo.tamanho_bytes > TETO_DE_BYTES_DO_ANEXO) {
    return {
      ok: false,
      erro: {
        codigo: "anexo_grande_demais",
        mensagem:
          `este anexo tem ${anexo.tamanho_bytes} bytes e o limite de leitura é ` +
          `${TETO_DE_BYTES_DO_ANEXO} (50 MB) — peça para anexarem uma versão menor.`,
      },
    };
  }

  // Imagem/binário: a MESMA régua de extensões do acervo decide o que é texto.
  if (resolverExtensao(anexo.nome, anexo.tipo) === null) {
    return {
      ok: true,
      anexo: {
        ...anexo,
        conteudo: null,
        truncado: false,
        legivel_como_texto: false,
        motivo:
          "este anexo é imagem ou binário — não transcrevo imagem aqui. " +
          "O arquivo está no negócio: peça a uma pessoa para abrir pelo caminho_da_midia " +
          "e digite apenas o que ela confirmar; não invente o conteúdo.",
      },
    };
  }

  const extrair = deps.extrair ?? extrairTextoDoArquivo;

  let texto: string;
  try {
    ({ texto } = await extrair(linha.storage_path, anexo.tipo || undefined, {
      bucket: BUCKET_DO_ANEXO_DO_NEGOCIO,
    }));
  } catch (err) {
    const motivo =
      err instanceof Error && err.message !== ""
        ? err.message
        : "não consegui abrir este arquivo — o conteúdo dele não foi lido.";
    return {
      ok: true,
      anexo: { ...anexo, conteudo: null, truncado: false, legivel_como_texto: false, motivo },
    };
  }

  const limpo = texto.trim();
  if (limpo === "") {
    return {
      ok: true,
      anexo: {
        ...anexo,
        conteudo: null,
        truncado: false,
        legivel_como_texto: false,
        motivo:
          "o documento abriu e não tem texto legível (é digitalizado como imagem?) — " +
          "não afirme nada sobre o conteúdo dele.",
      },
    };
  }

  if (limpo.length > TETO_DE_CARACTERES_DO_ANEXO) {
    return {
      ok: true,
      anexo: {
        ...anexo,
        conteudo: limpo.slice(0, TETO_DE_CARACTERES_DO_ANEXO),
        truncado: true,
        legivel_como_texto: true,
        motivo:
          `o documento tem ${limpo.length} caracteres e a leitura entregou os primeiros ` +
          `${TETO_DE_CARACTERES_DO_ANEXO}; o restante não foi lido — não afirme o que só estaria lá.`,
      },
    };
  }

  return {
    ok: true,
    anexo: { ...anexo, conteudo: limpo, truncado: false, legivel_como_texto: true, motivo: null },
  };
}
