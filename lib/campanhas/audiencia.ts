/**
 * A AUDIÊNCIA — quem recebe, escolhido por filtro sobre os dados que a
 * organização já tem.
 *
 * ═══ Por que filtro, e não lista colada ═══
 *
 * A primeira versão desta feature pedia os telefones num campo de texto, e a
 * lista do piloto foi montada por script. Isso é lista colada com CRM em volta:
 * o operador não confere o recorte, não repete amanhã, e "quem recebe" acaba
 * morando fora do sistema — numa planilha ou na cabeça de alguém.
 *
 * ═══ Uma regra, dois consumidores ═══
 *
 * A MESMA função monta a prévia (o que o operador vê antes de apertar) e o
 * snapshot (o que grava os destinatários). Duas implementações divergiriam no
 * dia em que alguém mexesse numa só, e a divergência apareceria como "a prévia
 * dizia 30 e foram 47".
 *
 * ═══ O que NÃO existe ═══
 *
 * Não existe "todos os contatos". Audiência sem recorte é o pedido que ninguém
 * revisa antes de apertar, e é assim que a organização inteira recebe por
 * engano. Pelo menos um critério é obrigatório.
 *
 * Nenhum nome de coluna vem do cliente: o filtro é um objeto fechado, validado
 * por Zod, e cada campo dele vira um predicado escrito aqui.
 */
import { z } from "zod";

/** Estados em que uma campanha ainda pretende falar com a lista dela. */
export const CAMPANHAS_VIVAS = [
  "draft",
  "preparing",
  "ready",
  "scheduled",
  "running",
  "paused",
] as const;

export const filtroDeAudienciaSchema = z
  .strictObject({
    /** Contato precisa ter TODAS estas etiquetas. */
    com_todas_tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
    /** Contato precisa ter PELO MENOS UMA destas. */
    com_alguma_tag: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
    /** Contato não pode ter NENHUMA destas. */
    sem_tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),

    /** Tem negócio aberto em algum destes funis. */
    funis: z.array(z.string().uuid()).max(20).default([]),
    /** ...em alguma destas etapas. */
    etapas: z.array(z.string().uuid()).max(50).default([]),
    /** ...com algum destes donos. */
    responsaveis: z.array(z.string().uuid()).max(50).default([]),
    /** Situação do negócio: `open`, `won`, `lost`. */
    situacoes_do_negocio: z.array(z.enum(["open", "won", "lost"])).max(3).default([]),

    /** Sem interação há N dias (silêncio) — o filtro de reativação. */
    sem_interacao_ha_dias: z.number().int().min(1).max(3650).nullable().default(null),
    /** Com interação nos últimos N dias. */
    com_interacao_ha_dias: z.number().int().min(0).max(3650).nullable().default(null),
    /** Cadastrado a partir de / até (ISO). */
    cadastrado_de: z.string().datetime().nullable().default(null),
    cadastrado_ate: z.string().datetime().nullable().default(null),
    /** `contacts.source` — de onde o contato veio. */
    origens: z.array(z.string().trim().min(1).max(40)).max(20).default([]),

    /** Contatos a incluir mesmo que o recorte não os pegue. */
    incluir_contatos: z.array(z.string().uuid()).max(5000).default([]),
    /** Contatos a tirar, mesmo que o recorte os pegue. */
    excluir_contatos: z.array(z.string().uuid()).max(5000).default([]),

    /** Teto do lote. A mesma régua do import de CSV para "quanta gente de uma vez". */
    limite: z.number().int().min(1).max(5000).default(500),
  })
  .refine(
    (f) =>
      f.com_todas_tags.length > 0 ||
      f.com_alguma_tag.length > 0 ||
      f.sem_tags.length > 0 ||
      f.funis.length > 0 ||
      f.etapas.length > 0 ||
      f.responsaveis.length > 0 ||
      f.situacoes_do_negocio.length > 0 ||
      f.origens.length > 0 ||
      f.sem_interacao_ha_dias !== null ||
      f.com_interacao_ha_dias !== null ||
      f.cadastrado_de !== null ||
      f.cadastrado_ate !== null ||
      f.incluir_contatos.length > 0,
    { message: "Escolha pelo menos um critério — audiência sem recorte não se confere." },
  );

export type FiltroDeAudiencia = z.infer<typeof filtroDeAudienciaSchema>;

/** Um filtro vazio, para campanha recém-criada. Não passa no `refine` — e é o ponto. */
export const FILTRO_VAZIO = {
  com_todas_tags: [],
  com_alguma_tag: [],
  sem_tags: [],
  funis: [],
  etapas: [],
  responsaveis: [],
  situacoes_do_negocio: [],
  sem_interacao_ha_dias: null,
  com_interacao_ha_dias: null,
  cadastrado_de: null,
  cadastrado_ate: null,
  origens: [],
  incluir_contatos: [],
  excluir_contatos: [],
  limite: 500,
} satisfies FiltroDeAudiencia;

/** Precisa olhar `crm_leads`? Só então o join entra — join à toa custa em toda prévia. */
export function usaNegocio(filtro: FiltroDeAudiencia): boolean {
  return (
    filtro.funis.length > 0 ||
    filtro.etapas.length > 0 ||
    filtro.responsaveis.length > 0 ||
    filtro.situacoes_do_negocio.length > 0
  );
}

/** A data-limite de "sem interação há N dias". Exportada para o teste não recalcular. */
export function limiteDeSilencio(dias: number, agora: Date): Date {
  return new Date(agora.getTime() - dias * 86_400_000);
}
