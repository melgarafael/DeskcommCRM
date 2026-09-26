/**
 * O INTERRUPTOR DO JEV — `organizations.settings.jev`.
 *
 * Mora em `settings`, e não em `ai_purpose_bindings`, por uma razão medida:
 * aquela tabela é única por (organização, ponto). Uma linha do Jev no ponto do
 * clima APAGARIA a escolha de modelo de linguagem daquele ponto, que é
 * justamente a reserva que assume quando o Jev falha. Aqui não há migration: o
 * Zod abaixo é o schema central do caminho.
 *
 * ═══ LEITURA NUNCA LANÇA, E FALHA DESLIGADA ═══
 *
 * Quem lê é o worker de clima, a cada mensagem. Qualquer coisa fora do schema
 * vira "desligado": ligar o Jev manda a mensagem do cliente para fora do país,
 * e um JSON torto não pode fazer isso por acidente. Pelo mesmo motivo, ligado
 * SEM o aceite do administrador também vale como desligado (LGPD).
 *
 * ═══ POR TAREFA (onda 2) ═══
 *
 * `ligado` continua o interruptor MESTRE. Cada tarefa (`./tarefas.ts`) tem o
 * seu estado em `tarefas.<id>`, e um valor ruim numa tarefa deixa só ELA
 * desligada — `.catch` por chave, e não um `z.record`, que recusaria o objeto
 * inteiro e desligaria o clima junto (medido no zod 4.6.5). Ilegível é
 * DESLIGADA, e não ausente: ausente, uma tarefa nova começa observando sozinha
 * (`./tarefas.ts`, item 5), e um estado que uma versão mais nova gravou e esta
 * não conhece — "desligada por outro nome" — voltaria a mandar mensagem para
 * fora. O `modo` da onda 1 segue sendo o estado do clima quando
 * `tarefas.clima` não existe: nada é reescrito na leitura, e a imagem
 * anterior, que não conhece `tarefas`, lê o `modo` e descarta o resto sem erro.
 */
import { z } from "zod";

import type { createAdminClient } from "@/lib/supabase/admin";

export const ESTADOS_DA_TAREFA = ["observando", "decidindo", "desligada"] as const;
export type EstadoDaTarefa = (typeof ESTADOS_DA_TAREFA)[number];
/**
 * Os estados em que a tarefa pergunta ao Jev — desligada não pergunta nada. É o
 * CHECK de `jev_observacoes.estado` (migration 0421), cobrado por
 * `tests/invariants/jev-observacoes.test.ts` ("o CHECK de `estado` aceita…").
 */
export const ESTADOS_QUE_PERGUNTAM = ["observando", "decidindo"] as const satisfies readonly EstadoDaTarefa[];
export type EstadoQuePergunta = (typeof ESTADOS_QUE_PERGUNTAM)[number];

/**
 * O que sai para o fornecedor, do mais estreito ao mais largo — a ORDEM é a
 * regra: tarefa que pede mais do que o aceite cobre fica desligada.
 */
export const ALCANCES = ["mensagem", "conversa"] as const;
export type Alcance = (typeof ALCANCES)[number];

const tarefaGravadaSchema = z.object({
  estado: z.enum(ESTADOS_DA_TAREFA),
  alterado_em: z.string().datetime().optional(),
  alterado_por: z.string().uuid().optional(),
});
export type TarefaGravada = z.infer<typeof tarefaGravadaSchema>;

/**
 * Uma chave por tarefa de `TAREFAS_DO_JEV` — `./tarefas.test.ts` cobra os dois
 * lados, e `./config.test.ts` cobra o `.catch` de CADA chave. Chave
 * desconhecida (de uma versão mais nova) é descartada na leitura e devolvida
 * na escrita (`tarefasDeOutraVersao`).
 */
const tarefaIlegivel = (): TarefaGravada => ({ estado: "desligada" });
const tarefasSchema = z.object({
  clima: tarefaGravadaSchema.optional().catch(tarefaIlegivel),
  manipulacao: tarefaGravadaSchema.optional().catch(tarefaIlegivel),
  roteador: tarefaGravadaSchema.optional().catch(tarefaIlegivel),
});

export const idDaTarefaSchema = tarefasSchema.keyof();
export type IdDaTarefa = z.infer<typeof idDaTarefaSchema>;

export const configDoJevSchema = z
  .object({
    ligado: z.boolean().default(false),
    /**
     * O estado do CLIMA na língua da onda 1. `observacao`: o Jev mede, a IA de
     * sempre decide. `decide`: o Jev decide. Gravar o clima grava os dois.
     */
    modo: z.enum(["observacao", "decide"]).default("observacao"),
    /**
     * Quem aceitou mandar a mensagem ao fornecedor estrangeiro, e quando.
     * `alcance` ausente é o aceite da onda 1: cada mensagem, sozinha. Aceite
     * ilegível é aceite nenhum — a config inteira cai no desligado.
     */
    aceite: z
      .object({
        em: z.string().datetime(),
        por: z.string().uuid(),
        alcance: z.enum(ALCANCES).optional(),
        versao: z.number().int().positive().optional(),
      })
      .nullable()
      .default(null),
    /**
     * Sem `.catch` aqui de propósito: o `tarefas` que nem é objeto não é "uma
     * tarefa ruim", é config ilegível, e cai no desligado como o aceite torto.
     * Um `.catch` neste nível também esconderia a falta do `.catch` de uma
     * chave — o objeto inteiro sumiria, e com ele as tarefas boas.
     */
    tarefas: tarefasSchema.optional(),
    alterado_em: z.string().datetime().optional(),
    alterado_por: z.string().uuid().optional(),
  })
  .refine((c) => !c.ligado || c.aceite !== null, {
    message: "ligar o Jev exige o aceite do administrador",
  });

export type ConfigDoJev = z.infer<typeof configDoJevSchema>;

const DESLIGADO: ConfigDoJev = { ligado: false, modo: "observacao", aceite: null };

export function lerConfigDoJev(settings: unknown): ConfigDoJev {
  const jev =
    settings !== null && typeof settings === "object"
      ? (settings as Record<string, unknown>).jev
      : undefined;
  const lido = configDoJevSchema.safeParse(jev ?? {});
  return lido.success ? lido.data : { ...DESLIGADO };
}

export type ResultadoDeGravarConfig =
  | { ok: true; config: ConfigDoJev }
  | { ok: false; motivo: "leitura_falhou" | "config_invalida" | "escrita_recusada" };

export type MudancaDaConfig = Partial<Pick<ConfigDoJev, "ligado" | "modo" | "aceite">> & {
  /** Só as tarefas que mudam; as outras ficam como estão. */
  tarefas?: Partial<Record<IdDaTarefa, EstadoDaTarefa>>;
};

export interface PedidoDeGravarConfig {
  admin: ReturnType<typeof createAdminClient>;
  /** Resolvido da SESSÃO por quem chama — nunca do corpo da requisição. */
  orgId: string;
  actorUserId: string;
  mudanca: MudancaDaConfig;
  agora?: Date;
}

const MODO_DO_ESTADO = { observando: "observacao", decidindo: "decide" } as const;
/** O `modo` da onda 1 dito como estado de tarefa — é o estado do clima quando `tarefas.clima` não existe. */
export const ESTADO_DO_MODO = { observacao: "observando", decide: "decidindo" } as const;

/**
 * A próxima config, sem tocar o banco. Duas regras além de espalhar a mudança:
 *
 *  - MESCLA PROFUNDA de `tarefas`: mudar uma tarefa nunca apaga as outras, e
 *    mudar `ligado` ou o aceite nunca apaga nenhuma.
 *  - O clima tem dois nomes, `modo` e `tarefas.clima`, e gravar um grava o
 *    outro. O `modo` é o que a imagem anterior lê: sem o espelho, um rollback
 *    devolveria o clima a um estado que ninguém escolheu. `desligada` não tem
 *    nome no `modo` e o deixa como está (a imagem anterior não sabe desligar
 *    uma tarefa só).
 */
export function mesclar(
  atual: ConfigDoJev,
  mudanca: MudancaDaConfig,
  carimbo: { em: string; por: string },
): unknown {
  const { tarefas: tarefasPedidas, ...resto } = mudanca;
  const pedidas: Partial<Record<IdDaTarefa, EstadoDaTarefa>> = { ...tarefasPedidas };
  if (pedidas.clima === undefined && mudanca.modo !== undefined) pedidas.clima = ESTADO_DO_MODO[mudanca.modo];
  const clima = pedidas.clima;

  const tarefas: Partial<Record<IdDaTarefa, TarefaGravada>> = { ...atual.tarefas };
  for (const id of idDaTarefaSchema.options) {
    const estado = pedidas[id];
    if (estado !== undefined) tarefas[id] = { estado, alterado_em: carimbo.em, alterado_por: carimbo.por };
  }

  return {
    ...atual,
    ...resto,
    ...(clima !== undefined && clima !== "desligada" ? { modo: MODO_DO_ESTADO[clima] } : {}),
    ...(Object.keys(tarefas).length > 0 ? { tarefas } : {}),
    alterado_em: carimbo.em,
    alterado_por: carimbo.por,
  };
}

/**
 * As tarefas que uma versão MAIS NOVA gravou e esta não conhece, como estão no
 * banco. A leitura as descarta; a escrita as devolve. Sem isso, voltar a imagem
 * e mexer no Jev apagaria, por exemplo, uma tarefa que a empresa DESLIGOU na
 * versão nova — e, de volta a ela, a tarefa reapareceria "nova", observando
 * sozinha (`./tarefas.ts`, item 5).
 */
function tarefasDeOutraVersao(settings: Record<string, unknown>): Record<string, unknown> {
  const jev = settings.jev;
  const tarefas = jev !== null && typeof jev === "object" ? (jev as Record<string, unknown>).tarefas : undefined;
  if (tarefas === null || typeof tarefas !== "object" || Array.isArray(tarefas)) return {};
  const conhecidas: readonly string[] = idDaTarefaSchema.options;
  return Object.fromEntries(Object.entries(tarefas).filter(([id]) => !conhecidas.includes(id)));
}

/**
 * Lê, mescla e grava. `settings` é jsonb COMPARTILHADO (marca, MFA, IA padrão,
 * onboarding): gravar `{ jev }` sozinho apagaria o resto em silêncio. O service
 * role passa por cima da RLS, então o `.eq("id", orgId)` é a única cerca entre
 * esta empresa e a instalação inteira. Auditar é de quem chama (a rota).
 */
export async function gravarConfigDoJev(p: PedidoDeGravarConfig): Promise<ResultadoDeGravarConfig> {
  const { data: org, error: leituraErr } = await p.admin
    .from("organizations")
    .select("settings")
    .eq("id", p.orgId)
    .maybeSingle();
  if (leituraErr || !org) return { ok: false, motivo: "leitura_falhou" };

  const settingsAtuais = (org.settings ?? {}) as Record<string, unknown>;
  const proxima = configDoJevSchema.safeParse(
    mesclar(lerConfigDoJev(settingsAtuais), p.mudanca, {
      em: (p.agora ?? new Date()).toISOString(),
      por: p.actorUserId,
    }),
  );
  if (!proxima.success) return { ok: false, motivo: "config_invalida" };

  const alheias = tarefasDeOutraVersao(settingsAtuais);
  const jev =
    Object.keys(alheias).length === 0
      ? proxima.data
      : { ...proxima.data, tarefas: { ...alheias, ...proxima.data.tarefas } };

  const { data: gravado, error: escritaErr } = await p.admin
    .from("organizations")
    .update({ settings: { ...settingsAtuais, jev } })
    .eq("id", p.orgId)
    .select("settings")
    .maybeSingle();
  // Zero linhas volta como SUCESSO no PostgREST: sem esta conferência, a tela
  // diria "ligado" para uma escrita que não aconteceu.
  if (escritaErr || !gravado) return { ok: false, motivo: "escrita_recusada" };

  return { ok: true, config: proxima.data };
}
