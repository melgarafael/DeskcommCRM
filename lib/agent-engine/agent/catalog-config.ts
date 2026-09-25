/**
 * Configuração do catálogo do agente (`ai_agents.config.catalog`).
 *
 * Decisões de APRESENTAÇÃO e de ESCOLHA das motos ficam aqui — não no prompt da
 * persona. O runtime lê este bloco; a tela do agente o edita; a API o valida.
 *
 * ─── Onde mora a QUANTIDADE (decisão do dono, 2026-09-25) ────────────────────
 * `similares_qtd` e `usar_limite_quantidade` vivem AQUI, na config do AGENTE.
 * O `catalog_mappings` (Integração de dados) guarda só a tabela/colunas e a
 * semelhança automática — a quantidade saiu de lá para não haver duas fontes.
 *
 * Defaults preservam o comportamento atual (sem surpresa para quem nunca abriu a
 * tela): `similaridade_deterministica: false` mantém a escolha pelo modelo; o
 * resto dos toggles liga o formato já validado ao vivo. Quem quer a regra fixa
 * de semelhança (cilindrada → preço) liga o toggle.
 */
import { z } from 'zod';

export const CRITERIOS_SIMILARIDADE = ['cilindrada', 'preco', 'tipo'] as const;

export const catalogConfigSchema = z
  .object({
    /**
     * Quantas ALTERNATIVAS oferecer quando o modelo pedido NÃO existe no
     * catálogo. Fonte ÚNICA (decisão do dono, 2026-09-25). 1..8.
     *
     * Só é aplicado se `usar_limite_quantidade` estiver ligado.
     */
    similares_qtd: z.number().int().min(1).max(8).default(3),
    /**
     * Toggle B (decisão do dono, 2026-09-25): aplicar o LIMITE de
     * `similares_qtd` das alternativas. Desligado = sem teto — mostra todas as
     * candidatas que casam/parecem. Default `true` (comportamento atual).
     */
    usar_limite_quantidade: z.boolean().default(true),
    /**
     * Toggle A (C-085): quando o cliente pede um MODELO que EXISTE (família que
     * casa uma ou mais unidades, ex.: "CB 300"), mostrar TODAS as unidades que
     * batem — em vez de recortar em `similares_qtd`. Default `true` (decisão do
     * dono, 2026-09-25): o cliente quer ver o que existe; recortar escondia
     * unidades reais. Quando o modelo NÃO existe, valem `similares_qtd` +
     * `usar_limite_quantidade`.
     */
    especificacao_mostra_todas: z.boolean().default(true),
    /** Prioridade dos critérios de semelhança, na ordem. */
    criterio: z.array(z.enum(CRITERIOS_SIMILARIDADE)).min(1).max(3).default(['cilindrada', 'preco']),
    /** Faixa (%) em torno do preço pedido que ainda conta como "parecido". */
    tolerancia_preco_pct: z.number().int().min(0).max(100).default(30),
    /** Ligar a escolha determinística (motor decide) em vez do julgamento do modelo. */
    similaridade_deterministica: z.boolean().default(false),
    /** Enviar uma foto por moto, com a legenda da própria moto. */
    foto_por_moto: z.boolean().default(true),
    /**
     * Quantas fotos enviar quando o cliente ESCOLHE uma moto específica (o motor
     * manda o detalhe dela sem depender do modelo).
     *
     * C-086: `0` = TODAS as fotos da moto (decisão do dono, 2026-09-25: o cliente
     * escolheu a moto, quer vê-la por inteiro). Máximo 50 quando for um número
     * positivo (era 10, que cortava catálogos com mais fotos por moto). Default
     * `0` = todas.
     */
    fotos_moto_escolhida: z.number().int().min(0).max(50).default(0),
    /** A abertura não cita/listra as motos (elas vão nas fotos). */
    abertura_sem_citar: z.boolean().default(true),
    /** A pergunta de avanço vai numa mensagem de texto separada, depois das fotos. */
    pergunta_separada: z.boolean().default(true),
    /** O motor anexa foto quando o modelo esquece. */
    enviar_foto_automatica: z.boolean().default(true),
  })
  .strict();

export type CatalogConfig = z.infer<typeof catalogConfigSchema>;

export const CATALOG_CONFIG_DEFAULT: CatalogConfig = catalogConfigSchema.parse({});

/**
 * Lê `ai_agents.config.catalog` de forma TOLERANTE: bloco ausente/parcial ou com
 * campo inválido não derruba o turno — cai no default. A validação estrita fica
 * na API (onde o erro vira 422 para quem editou); aqui é leitura de runtime.
 */
export function parseCatalogConfig(raw: unknown): CatalogConfig {
  if (raw === null || typeof raw !== 'object') return CATALOG_CONFIG_DEFAULT;
  const parsed = catalogConfigSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Parcial: preenche o que der e usa default no resto (nunca lança no runtime).
  const entries = Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(([k]) =>
      Object.prototype.hasOwnProperty.call(CATALOG_CONFIG_DEFAULT, k),
    ),
  );
  const parcial = catalogConfigSchema.safeParse({ ...CATALOG_CONFIG_DEFAULT, ...entries });
  return parcial.success ? parcial.data : CATALOG_CONFIG_DEFAULT;
}
