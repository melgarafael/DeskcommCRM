/**
 * O BLUEPRINT DE FUNIS — o segundo TIPO que atravessa o MESMO envelope de
 * `lib/templates/blueprint.ts` (issue #1995, fatia 2).
 *
 * ─── O que muda, e o que NÃO muda ──────────────────────────────────────────
 *
 * O envelope é o mesmo: `formato` (`respostas-rapidas.blueprint`, string
 * congelada e neutra de marca), `versao` 1, `gerado_em` e `itens`. O que muda é
 * o `tipo` (`funis`) e a FORMA de cada item — aqui, um funil com as etapas na
 * ordem em que aparecem no quadro.
 *
 * `formato` continua sendo o mesmo rótulo de propósito: é o nome do ENVELOPE,
 * não do conteúdo. Trocá-lo por `funis.blueprint` faria o arquivo de funis ser
 * recusado como "não é um blueprint" por uma instalação que só conhece o
 * envelope antigo, quando o motivo verdadeiro é outro — e a mensagem de recusa
 * passaria a mentir. Quem distingue os dois arquivos é o `tipo`, e por isso ele
 * é conferido por IGUALDADE: blueprint de respostas rápidas enviado na rota de
 * funis é recusado com `tipo`, nunca aplicado "no melhor esforço".
 *
 * ─── O que o arquivo leva de cada funil ────────────────────────────────────
 *
 *   - `nome` e `descricao`: as colunas `crm_pipelines.name` e `.description`,
 *     com os MESMOS tetos do POST (`/api/v1/pipelines`: 80 e 280);
 *   - `etapas`: `crm_stages.name` (teto 80, o mesmo do POST de etapa), `color`
 *     (a coluna existe e tem CHECK `^#[0-9a-fA-F]{6}$`), `is_won` e `is_lost`
 *     (as duas marcas de fechamento).
 *
 * Fica de fora, e não é esquecimento:
 *
 *   - `id`, `slug`, `position`: são da origem. Slug é técnico e colide por
 *     construção (`uniq_crm_pipelines_org_slug` / `uniq_crm_stages_pipeline_slug`);
 *     a posição aqui é a POSIÇÃO NO ARRAY, e o import renumera 0..n na ordem do
 *     arquivo — trazer a fração da origem para uma organização que não tem
 *     aquele quadro seria ficção;
 *   - `is_default` / `is_client_pipeline`: são marcas EXCLUSIVAS por
 *     organização (índices parciais). Um arquivo que as trouxesse poderia
 *     derrubar o funil padrão do destino ou criar dois "de clientes"; o import
 *     só marca `is_default` quando a organização ainda não tem nenhum funil —
 *     a mesma regra do POST;
 *   - `vocabulary` / `settings` (jsonb): vocabulário e custom fields são
 *     decisão de estrutura da empresa, não recorte de configuração de quadro;
 *   - das etapas: `description`, `expected_duration_hours`, `win_probability`,
 *     `avisar_na_central`, `requires_human`. São ajustes finos que a própria
 *     tela edita depois — e cada um deles é uma decisão de produto sobre o que
 *     "migrar um funil" significa. O arquivo leva o esqueleto que faz o quadro
 *     funcionar: colunas na ordem, com nome, cor e as marcas de ganho/perda.
 *
 * ─── Por que funil, e por que agora ────────────────────────────────────────
 *
 * `lib/templates/blueprint.ts` explica por que a PRIMEIRA fatia foi resposta
 * rápida. Funil era o caso seguinte mais próximo: tabela própria
 * (`crm_pipelines`) + filha (`crm_stages`) com `ON DELETE CASCADE`, nenhuma FK
 * para dado de negócio no que é exportado, e o import cria linhas NOVAS — o
 * arquivo nunca aponta para negócio, conversa ou usuário. Automação e agente
 * continuam fora: `automation_rules.actions` guarda `pipeline_id` dentro de
 * jsonb sem FK e o agente carrega canal, que é conexão da organização.
 */
import { z } from "zod";

import { chaveDeNome } from "@/lib/leads/stage-editing";
import {
  FORMATO_DO_BLUEPRINT,
  TETO_DE_ITENS_DO_BLUEPRINT,
  VERSAO_DO_BLUEPRINT,
  type MotivoDeRecusa,
} from "@/lib/templates/blueprint";

/** O tipo que este arquivo carrega. Um tipo por arquivo (ver o envelope). */
export const TIPO_FUNIS = "funis";

/** Os mesmos tetos do POST de funil (`app/api/v1/pipelines/route.ts`). */
export const LIMITE_DO_NOME_DO_FUNIL = 80;
export const LIMITE_DA_DESCRICAO_DO_FUNIL = 280;
/** O mesmo teto do POST de etapa (`app/api/v1/pipelines/[id]/stages/route.ts`). */
export const LIMITE_DO_NOME_DA_ETAPA = 80;

/**
 * O passo de `position` das etapas, o mesmo do POST de funil: 1000 entre
 * colunas deixa espaço para o arrasto fracionário sem renumerar o quadro.
 */
export const PASSO_DA_POSICAO_DA_ETAPA = 1000;

/** O que a rota de export lê de `crm_pipelines`. */
export interface FunilExportavel {
  id: string;
  name: string;
  description: string | null;
}

/** O que a rota de export lê de `crm_stages`. */
export interface EtapaExportavel {
  pipeline_id: string;
  name: string;
  color: string | null;
  is_won: boolean;
  is_lost: boolean;
}

/** Uma etapa dentro do arquivo. Sem id, sem slug, sem posição numérica. */
export interface EtapaDoBlueprintDeFunil {
  nome: string;
  cor: string | null;
  is_won: boolean;
  is_lost: boolean;
}

/** Um funil dentro do arquivo: nome, descrição e as etapas NA ORDEM. */
export interface ItemDeFunil {
  nome: string;
  descricao: string | null;
  etapas: EtapaDoBlueprintDeFunil[];
}

export interface BlueprintDeFunis {
  formato: typeof FORMATO_DO_BLUEPRINT;
  versao: typeof VERSAO_DO_BLUEPRINT;
  tipo: typeof TIPO_FUNIS;
  /** ISO de quando o arquivo foi gerado. Informativo: o import não confia nele. */
  gerado_em: string;
  itens: ItemDeFunil[];
}

export type LeituraDoBlueprintDeFunis =
  | { ok: true; itens: ItemDeFunil[] }
  | { ok: false; motivo: MotivoDeRecusa; detalhes?: unknown };

/**
 * Serializa os funis (já na ordem da tela) com as etapas agrupadas por funil.
 *
 * `etapas` chega na ordem do quadro (o `order by position` da rota) e é
 * consumida nessa ordem: o mesmo contrato de "a ordem é a ordem do array" do
 * envelope de respostas rápidas. Etapa de funil que não está na lista é
 * ignorada — a rota já filtrou por `pipeline_id in (...)`.
 */
export function blueprintDeFunis(
  funis: readonly FunilExportavel[],
  etapas: readonly EtapaExportavel[],
  agora: Date = new Date(),
): BlueprintDeFunis {
  const porFunil = new Map<string, EtapaDoBlueprintDeFunil[]>();
  for (const etapa of etapas) {
    const lista = porFunil.get(etapa.pipeline_id) ?? [];
    lista.push({
      nome: etapa.name,
      cor: etapa.color ?? null,
      is_won: etapa.is_won,
      is_lost: etapa.is_lost,
    });
    porFunil.set(etapa.pipeline_id, lista);
  }

  return {
    formato: FORMATO_DO_BLUEPRINT,
    versao: VERSAO_DO_BLUEPRINT,
    tipo: TIPO_FUNIS,
    gerado_em: agora.toISOString(),
    itens: funis.map((funil) => ({
      nome: funil.name,
      descricao: funil.description ?? null,
      etapas: porFunil.get(funil.id) ?? [],
    })),
  };
}

/** `funis-AAAA-MM-DD.json`, o mesmo desenho do export de respostas rápidas. */
export function nomeDoArquivoDeFunis(agora: Date = new Date()): string {
  return `funis-${agora.toISOString().slice(0, 10)}.json`;
}

/**
 * O cabeçalho do envelope, validado ANTES dos itens — a mesma ordem (e o mesmo
 * motivo) do leitor de respostas rápidas: arquivo da versão 2 não pode ser
 * recusado por "funil inválido".
 */
const cabecalhoSchema = z.object({
  formato: z.string(),
  versao: z.number(),
  tipo: z.string(),
  itens: z.unknown(),
});

const corSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .nullish()
  .transform((valor) => (valor === undefined ? null : valor));

const etapaSchema = z
  .object({
    nome: z.string().trim().min(1).max(LIMITE_DO_NOME_DA_ETAPA),
    cor: corSchema,
    /** Ausente = a mesma leitura do default da coluna (`false`). */
    is_won: z.boolean().default(false),
    is_lost: z.boolean().default(false),
  })
  // O CHECK `crm_stages_won_lost_mutex` do banco — recusar aqui é dizer o
  // motivo em português antes de o Postgres devolver um 23514 cru.
  .refine((etapa) => !(etapa.is_won && etapa.is_lost), {
    message: "A etapa não pode ser de ganho e de perda ao mesmo tempo.",
  });

const funilSchema = z.object({
  nome: z.string().trim().min(1).max(LIMITE_DO_NOME_DO_FUNIL),
  descricao: z
    .string()
    .trim()
    .max(LIMITE_DA_DESCRICAO_DO_FUNIL)
    .nullish()
    .transform((valor) => (valor === undefined ? null : valor)),
  /** Funil sem etapa é quadro morto — o arquivo não pode gerar um. */
  etapas: z.array(etapaSchema).min(1).max(TETO_DE_ITENS_DO_BLUEPRINT),
});

/**
 * As duas marcas de fechamento são EXCLUSIVAS por funil no banco
 * (`uniq_crm_stages_pipeline_won` / `_lost`, parciais em `is_archived = false`).
 * Um arquivo com duas etapas de ganho seria recusado pelo Postgres com um
 * erro de índice — o motivo certo é "itens", dito antes da escrita.
 */
const itensSchema = z
  .array(funilSchema)
  .min(1)
  .max(TETO_DE_ITENS_DO_BLUEPRINT)
  .superRefine((funis, ctx) => {
    funis.forEach((funil, indice) => {
      if (funil.etapas.filter((etapa) => etapa.is_won).length > 1) {
        ctx.addIssue({
          code: "custom",
          path: [indice, "etapas"],
          message: "O funil tem mais de uma etapa de ganho.",
        });
      }
      if (funil.etapas.filter((etapa) => etapa.is_lost).length > 1) {
        ctx.addIssue({
          code: "custom",
          path: [indice, "etapas"],
          message: "O funil tem mais de uma etapa de perda.",
        });
      }
    });
  });

/**
 * Lê um blueprint de fora. Nada do corpo é confiado: o cabeçalho diz o que o
 * arquivo é, e só depois os itens passam pelo schema.
 *
 * A recusa por `tipo` é o ponto do desenho: o arquivo de respostas rápidas tem
 * o MESMO `formato` e a MESMA `versao`, então só o `tipo` impede que ele seja
 * aplicado como se fosse de funis (e vice-versa, no leitor de lá).
 */
export function lerBlueprintDeFunis(bruto: unknown): LeituraDoBlueprintDeFunis {
  const cabecalho = cabecalhoSchema.safeParse(bruto);
  if (!cabecalho.success) return { ok: false, motivo: "formato" };
  if (cabecalho.data.formato !== FORMATO_DO_BLUEPRINT) return { ok: false, motivo: "formato" };
  if (cabecalho.data.versao !== VERSAO_DO_BLUEPRINT) return { ok: false, motivo: "versao" };
  if (cabecalho.data.tipo !== TIPO_FUNIS) return { ok: false, motivo: "tipo" };

  const itens = itensSchema.safeParse(cabecalho.data.itens);
  if (!itens.success) {
    return {
      ok: false,
      motivo: "itens",
      // Caminho + motivo, um por problema (teto de 20 para o corpo do erro não
      // repetir o arquivo inteiro quando todos os funis estão errados).
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

/** O sufixo da cópia: `Nome (importado)`, `Nome (importado 2)`, … */
const SUFIXO_DA_COPIA = " (importado)";

/**
 * O nome com que o funil do arquivo nasce no destino.
 *
 * ⚠️ IMPORT NUNCA SOBRESCREVE. Nome que já existe (na régua de
 * `chaveDeNome`, a mesma de `validarNomeDeFunil` — caixa, acento e espaço não
 * distinguem) vira CÓPIA com sufixo, e o sufixo seguinte ganha número. O
 * original fica intocado, com as etapas dele.
 *
 * O corte respeita o teto de 80 do POST: um nome de 80 caracteres mais o
 * sufixo estouraria o contrato de escrita, e o import cairia num 422 que o
 * arquivo não explica. `trimEnd` porque o corte pode terminar em espaço.
 */
export function nomeDeCopia(nome: string, nomesExistentes: readonly string[]): string {
  const ocupados = new Set(nomesExistentes.map((existente) => chaveDeNome(existente)));
  const limpo = nome.trim();
  if (!ocupados.has(chaveDeNome(limpo))) return limpo;

  for (let n = 1; ; n++) {
    const sufixo = n === 1 ? SUFIXO_DA_COPIA : ` (importado ${n})`;
    const base = limpo.slice(0, LIMITE_DO_NOME_DO_FUNIL - sufixo.length).trimEnd();
    const candidato = `${base}${sufixo}`;
    if (!ocupados.has(chaveDeNome(candidato))) return candidato;
  }
}
