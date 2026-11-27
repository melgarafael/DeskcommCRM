/**
 * OS ARQUIVOS DA PRIMEIRA ABORDAGEM QUE NENHUMA CAMPANHA USA (#5139).
 *
 * O upload (`app/api/v1/prospecting/arquivo/route.ts`) grava o arquivo em
 * `{org}/prospecting/<uuid>.<ext>` no bucket `whatsapp-media` ASSIM QUE ele é
 * escolhido na tela. Só que trocar de arquivo, desistir da campanha ou apagá-la
 * deixa o objeto no bucket: nada o apaga. No self-host esse bucket é a MESMA
 * cota de 1 GB das mídias do atendimento, e um vídeo de abordagem pesa vários
 * MB — algumas trocas ocupam uma fatia que o operador não vê.
 *
 * ── Por que o cron de retenção não resolvia ─────────────────────────────────
 *
 * `fn_enfileirar_midia_vencida` (0557) acha `vencidas` e `orfas` olhando LINHAS
 * DE BANCO. Um arquivo que nenhuma campanha referencia não tem linha nenhuma:
 * ele nunca é visto por aquela função. Este módulo é o que enxerga o bucket
 * diretamente e fecha exatamente esse buraco.
 *
 * ── As três cercas (nunca afrouxar) ────────────────────────────────────────
 *
 *   1. SÓ `{org}/prospecting/` — o caminho é conferido por
 *      `caminhoPertenceAPastaDaAbordagem`, que exige o prefixo da PRÓPRIA
 *      organização. Outro prefixo é outro dono (mídia de atendimento, resposta
 *      rápida, proposta) e nunca entra na lista de remoção.
 *   2. NUNCA o referenciado — o conjunto de `storage_path` de TODAS as
 *      campanhas da organização é a prova de posse-por-referência. Arquivo nele
 *      fica, mesmo velho.
 *   3. NUNCA dentro da carência — o `list` do Storage informa `created_at`/
 *      `updated_at`. Arquivo novo pode ser de um upload cuja configuração ainda
 *      não foi salva; a carência dá a essa janela tempo de sobra. Sem idade
 *      conhecida, o arquivo é PRESERVADO: não dá para provar que está velho.
 *
 * Módulo PURO no que importa: recebe um cliente de Storage de interface mínima
 * (`list`, `remove`) e o conjunto de caminhos referenciados, devolve o
 * resultado. Quem fala com o Supabase é o adaptador no cron, testado com um
 * Storage falso — nenhuma rede aqui.
 */
import { isMediaPathInOrganization } from "@/lib/messaging/media/upload-validation";

import { BUCKET_DA_MIDIA_DA_CAMPANHA } from "./midia-da-abordagem";

/** O bucket onde o arquivo da abordagem mora — o mesmo das mídias do atendimento. */
export const BUCKET_DOS_ARQUIVOS_DA_ABORDAGEM = BUCKET_DA_MIDIA_DA_CAMPANHA;

/** A pasta, dentro da organização, onde TODO arquivo da abordagem nasce. */
export const PASTA_DOS_ARQUIVOS_DA_ABORDAGEM = "prospecting";

/**
 * A carência até o arquivo poder ser removido, em dias. Sete dias é o prazo do
 * rascunho sugerido (`RETENCAO_RASCUNHO_DIAS_PISO`) e cobre com folga o intervalo
 * entre o upload e a gravação da configuração (o operador pode escolher o
 * arquivo e salvar a campanha depois). Constante, não knob: um número por `.env`
 * para "arquivo sem dono há quanto tempo" convidaria a zerar a carência e apagar
 * upload em andamento.
 */
export const CARENCIA_DOS_ARQUIVOS_ORFAOS_DIAS = 7;

/** Um objeto como o `list` do Storage o descreve, já normalizado. */
export interface ArquivoDaAbordagemNoBucket {
  /** Caminho COMPLETO no bucket, já com `{org}/prospecting/`. */
  caminho: string;
  /** Tamanho em bytes, quando o `list` informa (`metadata.size`); senão `null`. */
  bytes: number | null;
  /** Instante de criação no Storage, quando informado. */
  criadoEm: Date | null;
  /** Instante da última atualização no Storage, quando informado. */
  atualizadoEm: Date | null;
}

/**
 * A superfície MÍNIMA do Storage que a limpeza usa. Existe para o teste injetar
 * um falso sem rede e para a regra não depender do SDK do Supabase.
 */
export interface ClienteDeStorageDaAbordagem {
  /**
   * Os arquivos sob `prefixo` (a pasta `{org}/prospecting`, sem barra final).
   * O adaptador devolve o caminho COMPLETO (`{org}/prospecting/<uuid>.<ext>`).
   */
  list(prefixo: string): Promise<{ arquivos: ArquivoDaAbordagemNoBucket[]; erro?: string | null }>;
  /** Remove os caminhos pedidos. `removidos` é o que o Storage confirmou. */
  remove(
    caminhos: readonly string[],
  ): Promise<{ removidos: string[]; erro?: string | null }>;
}

/** O que sobrou de uma passada numa organização — contagens para a trilha. */
export interface ResultadoDaLimpezaDaAbordagem {
  organizationId: string;
  /** Quantos arquivos foram removidos. */
  removidos: number;
  /** Soma dos bytes removidos, só dos que o `list` informou tamanho. */
  bytes_removidos: number;
  /** Caminho + bytes de cada removido — a trilha de auditoria. */
  caminhos_removidos: Array<{ caminho: string; bytes: number | null }>;
  /** Preservados porque ALGUMA campanha da organização os referencia. */
  preservados_por_referencia: number;
  /** Preservados porque ainda estão dentro da carência. */
  preservados_pela_carencia: number;
  /** Preservados porque o `list` não informou idade — não dá para provar que são velhos. */
  preservados_sem_idade: number;
  /** Preservados porque o caminho não é `{org}/prospecting/` desta organização. */
  preservados_fora_da_pasta: number;
  /** Falha do Storage (list ou remove), quando houve. */
  erro: string | null;
}

/**
 * A pasta COMPLETA da abordagem desta organização, SEM barra final — o formato
 * que o `list` do Storage espera.
 */
export function pastaDosArquivosDaAbordagem(organizationId: string): string {
  return `${organizationId}/${PASTA_DOS_ARQUIVOS_DA_ABORDAGEM}`;
}

/**
 * O caminho pertence à pasta de abordagem DESTA organização?
 *
 * Reusa `isMediaPathInOrganization` (a mesma régua do `validateConfig`) para
 * herdar as recusas de `%`, `?`, `#`, controle, espaço final, `.` e `..`; e
 * exige o segundo segmento `prospecting`, para nenhuma pasta de outro dono
 * (conversa, resposta rápida, proposta) entrar na remoção.
 */
export function caminhoPertenceAPastaDaAbordagem(
  caminho: string,
  organizationId: string,
): boolean {
  if (!isMediaPathInOrganization(caminho, organizationId)) return false;
  const segmentos = caminho.split("/");
  return segmentos[1] === PASTA_DOS_ARQUIVOS_DA_ABORDAGEM && segmentos.length >= 3;
}

/** As contagens zeradas — o formato de retorno quando não há o que fazer. */
function vazio(organizationId: string, erro: string | null = null): ResultadoDaLimpezaDaAbordagem {
  return {
    organizationId,
    removidos: 0,
    bytes_removidos: 0,
    caminhos_removidos: [],
    preservados_por_referencia: 0,
    preservados_pela_carencia: 0,
    preservados_sem_idade: 0,
    preservados_fora_da_pasta: 0,
    erro,
  };
}

/**
 * Remove, numa organização, os arquivos de `{org}/prospecting/` que NENHUMA
 * campanha referencia e que já passaram da carência.
 *
 * A ordem das guardas é deliberada: pasta primeiro (nunca apagar de outro dono),
 * referência depois (nunca apagar o que está em uso), idade por último (nunca
 * apagar upload em andamento). Um arquivo só entra na remoção quando passa nas
 * três.
 *
 * `erro` no `list` aborta a passada sem remover nada; `erro` no `remove`
 * devolve as contagens zeradas com o motivo. Nunca lança por falha de Storage —
 * quem decide o que fazer com a falha é o dreno do cron.
 */
export async function limparArquivosOrfaosDaAbordagem(args: {
  organizationId: string;
  referenciados: readonly string[];
  storage: ClienteDeStorageDaAbordagem;
  carenciaDias?: number;
  agora?: Date;
}): Promise<ResultadoDaLimpezaDaAbordagem> {
  const { organizationId, referenciados, storage } = args;
  const carenciaDias = args.carenciaDias ?? CARENCIA_DOS_ARQUIVOS_ORFAOS_DIAS;
  const agora = args.agora ?? new Date();
  const limite = agora.getTime() - carenciaDias * 86_400_000;

  const referenciadosSet = new Set(referenciados);
  const resultado = vazio(organizationId);

  const listado = await storage.list(pastaDosArquivosDaAbordagem(organizationId));
  if (listado.erro) return { ...resultado, erro: listado.erro };

  const aRemover: ArquivoDaAbordagemNoBucket[] = [];
  for (const arquivo of listado.arquivos) {
    // 1. Outro dono nunca entra — mesmo que o `list` (ou um falso) devolva.
    if (!caminhoPertenceAPastaDaAbordagem(arquivo.caminho, organizationId)) {
      resultado.preservados_fora_da_pasta += 1;
      continue;
    }
    // 2. Referenciado por QUALQUER campanha da organização fica, mesmo velho.
    if (referenciadosSet.has(arquivo.caminho)) {
      resultado.preservados_por_referencia += 1;
      continue;
    }
    // 3. Sem idade conhecida não há como provar que está velho: preserva.
    const instante = arquivo.criadoEm ?? arquivo.atualizadoEm;
    if (!instante || Number.isNaN(instante.getTime())) {
      resultado.preservados_sem_idade += 1;
      continue;
    }
    if (instante.getTime() > limite) {
      resultado.preservados_pela_carencia += 1;
      continue;
    }
    aRemover.push(arquivo);
  }

  if (aRemover.length === 0) return resultado;

  const remocao = await storage.remove(aRemover.map((a) => a.caminho));
  if (remocao.erro) return { ...resultado, erro: remocao.erro };

  // Só conta o que o Storage confirmou E que estava na lista permitida: um
  // adaptador que devolvesse caminho de outro dono não entra na trilha.
  const permitidos = new Map(aRemover.map((a) => [a.caminho, a.bytes]));
  const removidos = remocao.removidos.filter((caminho) => permitidos.has(caminho));

  let bytes = 0;
  for (const caminho of removidos) {
    const tamanho = permitidos.get(caminho) ?? null;
    resultado.caminhos_removidos.push({ caminho, bytes: tamanho });
    if (tamanho) bytes += tamanho;
  }
  resultado.removidos = removidos.length;
  resultado.bytes_removidos = bytes;
  return resultado;
}

/**
 * A fonte que o cron precisa para limpar a instalação inteira: as organizações,
 * os caminhos que as campanhas delas referenciam e o Storage de cada uma.
 *
 * É interface (e não o admin client direto) para o teste exercitar o laço de
 * organizações com um falso — o mesmo motivo de `PodaDb` no cron.
 */
export interface FonteDaProspeccao {
  /** As organizações da instalação (hoje: `admin.from("organizations").select("id")`). */
  organizacoes(): Promise<string[]>;
  /** Os `storage_path` de `midia_da_abordagem` de TODAS as campanhas da organização. */
  caminhosReferenciados(organizationId: string): Promise<string[]>;
  /** O Storage de `{org}/prospecting/` da organização. */
  storageDaAbordagem(organizationId: string): ClienteDeStorageDaAbordagem;
}

/** O relatório agregado da limpeza, uma linha por rodada do cron. */
export interface ResultadoDoDrenoDaAbordagem {
  /** Quantas organizações foram varridas. */
  organizacoes: number;
  removidos: number;
  bytes_removidos: number;
  /** Caminho + bytes de cada removido, na ordem das organizações. */
  caminhos: Array<{ caminho: string; bytes: number | null }>;
  /** Falhas por organização, já nomeadas. A rodada SEGUE as outras organizações. */
  falhas: string[];
}

/**
 * Varre TODAS as organizações e limpa os órfãos de cada uma.
 *
 * A falha de UMA organização não derruba as demais: cada erro vira uma linha em
 * `falhas`, e o laço continua — o mesmo desenho de `executarDreno` no cron,
 * aplicado um nível abaixo. Se `organizacoes()` em si falhar, a exceção sobe e
 * o dreno inteiro é nomeado pelo cron.
 */
export async function drenarArquivosOrfaosDaAbordagem(
  fonte: FonteDaProspeccao,
  opcoes: { carenciaDias?: number; agora?: Date } = {},
): Promise<ResultadoDoDrenoDaAbordagem> {
  const organizacoes = await fonte.organizacoes();
  const resultado: ResultadoDoDrenoDaAbordagem = {
    organizacoes: organizacoes.length,
    removidos: 0,
    bytes_removidos: 0,
    caminhos: [],
    falhas: [],
  };

  for (const organizationId of organizacoes) {
    try {
      const referenciados = await fonte.caminhosReferenciados(organizationId);
      const limpeza = await limparArquivosOrfaosDaAbordagem({
        organizationId,
        referenciados,
        storage: fonte.storageDaAbordagem(organizationId),
        carenciaDias: opcoes.carenciaDias,
        agora: opcoes.agora,
      });
      resultado.removidos += limpeza.removidos;
      resultado.bytes_removidos += limpeza.bytes_removidos;
      resultado.caminhos.push(...limpeza.caminhos_removidos);
      if (limpeza.erro) {
        resultado.falhas.push(`organizacao ${organizationId}: ${limpeza.erro}`.slice(0, 300));
      }
    } catch (err) {
      const detalhe = err instanceof Error ? err.message : String(err);
      resultado.falhas.push(`organizacao ${organizationId}: ${detalhe}`.slice(0, 300));
    }
  }

  return resultado;
}
