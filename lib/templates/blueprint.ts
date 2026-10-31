/**
 * O ARQUIVO DE BLUEPRINT — a configuração de uma organização que vira arquivo
 * e pode ser aplicada em outra (issue #1995).
 *
 * ─── O que este arquivo é, e o que ele NÃO é ────────────────────────────────
 *
 * É um recorte MÍNIMO e versionado: as RESPOSTAS RÁPIDAS COMPARTILHADAS de uma
 * organização, sem id, sem dono, sem data e sem mídia. Não é um "marketplace",
 * não é snapshot do banco e não é o pacote LGPD (`contacts/export`), que
 * serializa DADOS do titular — configuração e dado pessoal são perguntas
 * diferentes, e misturar as duas é como uma exportação de rotina vira
 * vazamento de base.
 *
 * Por que respostas rápidas e não funil/etapas/automação/agente (a medição da
 * issue, medida na main): é a ÚNICA entidade de configuração em que
 *
 *   - a tabela é própria (`message_templates`) e o contrato de fio já existe
 *     (`createTemplateSchema`, `lib/schemas/templates.ts`);
 *   - nenhuma coluna aponta para ID de negócio (funil, etapa, canal, agente) —
 *     só `organization_id` e `owner_user_id`, e o import cria linhas novas, sem
 *     FK para a origem;
 *   - NÃO há índice único no conteúdo, então importar não colide por
 *     construção e não precisa inventar política de duplicidade.
 *
 * Funil/etapas exigem decidir o que fazer com `is_default` e com slug
 * colidente (5 índices únicos por org); automação e follow-up guardam
 * `pipeline_id` DENTRO de jsonb sem FK; agente carrega canal, que é conexão da
 * org. Os três são decisão do mantenedor, não recorte de PR.
 *
 * ─── O que fica de fora do arquivo, e por quê ───────────────────────────────
 *
 *   - `id`: é da origem e não significa nada no destino;
 *   - `owner_user_id`: as compartilhadas têm dono `null` por definição, e as
 *     PESSOAIS não são exportadas — são de um usuário da origem e não têm dono
 *     no destino (ver a rota de export);
 *   - `midias`: `storage_path` aponta para o bucket privado `whatsapp-media` no
 *     prefixo `<org>/templates/<template>/` — caminho de OUTRA organização.
 *     Exportar o caminho seria prometer um arquivo que o destino não tem (e que
 *     o destino nem pode ler). A contagem do que ficou de fora vai no audit;
 *   - `created_at`/`updated_at`: carimbo da origem, não configuração.
 *
 * ─── A ORDEM é a ordem do array ─────────────────────────────────────────────
 *
 * `ordem` é `numeric` fracionária no banco (a conta de `lib/templates/ordem.ts`
 * para o arrasto não renumerar a lista). O número não significa nada fora da
 * origem — trazer 137.5 para uma organização que não tem 137 seria ficção. Aqui
 * a ordem é a POSIÇÃO no array: quem lê o JSON enxerga a lista na ordem em que
 * ela aparece, e quem edita o arquivo reordena movendo a linha. O import
 * renumera 0..n-1 por essa posição, sem tentar preservar fração nenhuma.
 */
import { z } from "zod";

/**
 * O que o envelope diz de si mesmo: quem lê pode recusar antes de entender.
 *
 * SEM marca, e isso é escolha, não descuido: o arquivo atravessa instalações —
 * a de origem pode ser a de um revendedor com nome próprio. Um rótulo derivado
 * de `branding()` faria o blueprint exportado por uma clínica não ser
 * reconhecido pela instalação de destino (o `formato` é comparado por
 * igualdade, ver `lerBlueprintDeRespostasRapidas`), e o sintoma seria "arquivo
 * inválido" para um arquivo correto. Como a string é nova, ela nasce neutra em
 * vez de entrar na lista congelada da catraca de marca.
 */
export const FORMATO_DO_BLUEPRINT = "respostas-rapidas.blueprint";
/** A versão do FORMATO. Arquivo de outra versão é recusado com o número na mão. */
export const VERSAO_DO_BLUEPRINT = 1;
/** O tipo de configuração que este envelope carrega. Um tipo por arquivo. */
export const TIPO_RESPOSTAS_RAPIDAS = "respostas_rapidas";

/**
 * Teto de itens. 200 é o que cabe num insert só (uma transação no PostgREST):
 * import pela metade é pior que import recusado, e o teto também é o que impede
 * um arquivo forjado de virar dezenas de milhares de linhas num POST.
 */
export const TETO_DE_ITENS_DO_BLUEPRINT = 200;

/** Os mesmos tetos de `createTemplateSchema` — o arquivo não aceita mais que o POST. */
export const LIMITE_DO_TITULO = 80;
export const LIMITE_DO_CORPO = 4096;
export const LIMITE_DO_ATALHO = 40;

/**
 * O que a rota de export lê do banco. `midias` entra só para CONTAR o que não
 * viaja; `owner_user_id` já foi filtrado no `where` (só `null` sai daqui).
 */
export interface LinhaExportavel {
  title: string;
  body: string;
  shortcut: string | null;
  mostrar_na_barra?: boolean | null;
  midias?: unknown;
}

/** Uma resposta rápida dentro do arquivo. Sem id, sem dono, sem caminho de mídia. */
export interface ItemDoBlueprint {
  titulo: string;
  corpo: string;
  atalho: string | null;
  mostrar_na_barra: boolean;
}

export interface BlueprintDeRespostasRapidas {
  formato: typeof FORMATO_DO_BLUEPRINT;
  versao: typeof VERSAO_DO_BLUEPRINT;
  tipo: typeof TIPO_RESPOSTAS_RAPIDAS;
  /** ISO de quando o arquivo foi gerado. Informativo: o import não confia nele. */
  gerado_em: string;
  itens: ItemDoBlueprint[];
}

/** Por que um arquivo foi recusado — cada motivo tem mensagem e status próprios. */
export type MotivoDeRecusa = "formato" | "versao" | "tipo" | "itens";

export type LeituraDoBlueprint =
  | { ok: true; itens: ItemDoBlueprint[] }
  | { ok: false; motivo: MotivoDeRecusa; detalhes?: unknown };

/**
 * O cabeçalho, validado ANTES dos itens de propósito: um arquivo da versão 2
 * não pode ser recusado por "item inválido" — o motivo que interessa é a
 * versão, e a mensagem tem de dizer isso.
 */
const cabecalhoSchema = z.object({
  formato: z.string(),
  versao: z.number(),
  tipo: z.string(),
  itens: z.unknown(),
});

const itemSchema = z.object({
  titulo: z.string().trim().min(1).max(LIMITE_DO_TITULO),
  corpo: z.string().trim().max(LIMITE_DO_CORPO).default(""),
  atalho: z
    .string()
    .trim()
    .min(1)
    .max(LIMITE_DO_ATALHO)
    .nullish()
    .transform((valor) => valor ?? null),
  /** Ausente = ligado, a mesma leitura da coluna (default `true`). */
  mostrar_na_barra: z.boolean().default(true),
});

const itensSchema = z.array(itemSchema).min(1).max(TETO_DE_ITENS_DO_BLUEPRINT);

/** Quantas mídias a linha tem — o que NÃO viaja no arquivo, contado para o audit. */
export function contarMidias(linha: LinhaExportavel): number {
  return Array.isArray(linha.midias) ? linha.midias.length : 0;
}

/**
 * Serializa as linhas (já na ordem da tela) no envelope.
 *
 * `midiasNaoExportadas` é a conta honesta do que o arquivo deixou para trás: o
 * import não pode recriar a imagem, e quem exporta tem de saber que as
 * respostas vão chegar como texto.
 */
export function blueprintDasRespostasRapidas(
  linhas: readonly LinhaExportavel[],
  agora: Date = new Date(),
): { blueprint: BlueprintDeRespostasRapidas; midiasNaoExportadas: number } {
  const itens: ItemDoBlueprint[] = linhas.map((linha) => ({
    titulo: linha.title,
    corpo: linha.body,
    atalho: linha.shortcut,
    // Ausente/nulo na linha = ligado, como o default da coluna e o do contrato.
    mostrar_na_barra: linha.mostrar_na_barra ?? true,
  }));

  return {
    blueprint: {
      formato: FORMATO_DO_BLUEPRINT,
      versao: VERSAO_DO_BLUEPRINT,
      tipo: TIPO_RESPOSTAS_RAPIDAS,
      gerado_em: agora.toISOString(),
      itens,
    },
    midiasNaoExportadas: linhas.reduce((total, linha) => total + contarMidias(linha), 0),
  };
}

/** `respostas-rapidas-AAAA-MM-DD.json`, o mesmo desenho do export de contatos. */
export function nomeDoArquivo(agora: Date = new Date()): string {
  return `respostas-rapidas-${agora.toISOString().slice(0, 10)}.json`;
}

/**
 * Lê um blueprint de fora. Nada do corpo é confiado: o cabeçalho diz o que o
 * arquivo é, e só depois os itens passam pelo schema.
 *
 * O cabeçalho aceita chave extra de propósito (arquivo gerado por uma
 * instalação futura que ganhe um campo informativo não deve ser recusado por
 * isso) — o que NÃO se aceita é formato, versão ou tipo diferentes, porque aí o
 * conteúdo pode não ser o que se está lendo.
 */
export function lerBlueprintDeRespostasRapidas(bruto: unknown): LeituraDoBlueprint {
  const cabecalho = cabecalhoSchema.safeParse(bruto);
  if (!cabecalho.success) return { ok: false, motivo: "formato" };
  if (cabecalho.data.formato !== FORMATO_DO_BLUEPRINT) return { ok: false, motivo: "formato" };
  if (cabecalho.data.versao !== VERSAO_DO_BLUEPRINT) return { ok: false, motivo: "versao" };
  if (cabecalho.data.tipo !== TIPO_RESPOSTAS_RAPIDAS) return { ok: false, motivo: "tipo" };

  const itens = itensSchema.safeParse(cabecalho.data.itens);
  if (!itens.success) {
    return {
      ok: false,
      motivo: "itens",
      // Caminho + motivo, um por item recusado (teto de 20 para o corpo do erro
      // não repetir o arquivo inteiro quando todos os itens estão errados).
      detalhes: {
        itens: itens.error.issues.slice(0, 20).map((problema) => ({
          caminho: problema.path.join("."),
          mensagem: problema.message,
        })),
      },
    };
  }
  return { ok: true, itens: itens.data };
}
