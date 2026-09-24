/**
 * Os MÓDULOS OPCIONAIS da instalação: desligados por padrão, ligados pelo dono
 * do servidor em `/admin/sistema`.
 *
 * ─── De onde vem ────────────────────────────────────────────────────────────
 *
 * Doc 37 (18/09): o banco de dados externo é "módulo opcional da instalação,
 * desligado por padrão — o mesmo caminho da telefonia". Ele abre uma porta de
 * saída de rede e de credencial que a maioria dos clientes não usa; desligado,
 * quem não liga não carrega o risco. E o doc 24: todo liga/desliga de
 * configuração geral tem lugar na tela de admin, sem `.env`. O #1372 entrou sem
 * a chave — a tela de cadastrar banco aparecia para toda empresa.
 *
 * ─── Por que `platform_config` (0341), e não uma coluna em `platform_settings` ─
 *
 * `platform_settings` é singleton, e CRIAR a linha dele tem efeito colateral:
 * `signup_mode` nasce `'aberto'` pelo default da coluna, e linha presente vence o
 * `SIGNUP_MODE` do `.env` (ver `lib/auth/politica-de-cadastro.ts`). Ligar um
 * módulo numa instalação que nunca abriu a tela de cadastro reabriria o cadastro
 * dela. Em `platform_config` cada chave é uma linha própria: ligar isto não toca
 * em mais nada, e a migração de dados (0384) pode escrevê-la sem risco.
 *
 * ─── A regra de leitura ─────────────────────────────────────────────────────
 *
 * Só o valor `ligado` liga. Linha ausente, outro valor, ou banco que não
 * respondeu = DESLIGADO — falha fechada, porque o que o módulo guarda atrás da
 * porta é credencial de outro sistema. Não há piso no `.env`: a decisão do dono
 * é que a chave mora na tela.
 *
 * O cliente entra por PARÂMETRO: o motor do agente é outro processo e chega aqui
 * com o próprio cliente de serviço; o Next passa `createAdminClient()`. A tabela
 * não tem policy (0341): só o service role a lê.
 *
 * ponytail: sem memo — é uma leitura por chave primária, no mesmo `Promise.all`
 * das consultas que o layout já faz. Memo de processo (como `comportamento.ts`)
 * só se isto aparecer medido num perfil.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/**
 * `banco_externo` liga/desliga por uma linha em `platform_config` (ver o resto deste arquivo).
 * `honorarios` é um MÓDULO DE TABELA (ADR-0002): a fonte da verdade é `modulos_instalados`,
 * escrita só por `fn_modulo_instalar` (`lib/modulos/service.ts`), nunca por esta tela. Os dois
 * tipos convivem na mesma lista porque é isso que `deModuloDesligado` (catálogo de tools MCP)
 * precisa: "este módulo, seja qual for o mecanismo por trás, está ligado nesta instalação?".
 */
export const MODULOS_OPCIONAIS = ["banco_externo", "honorarios"] as const;
export type ModuloOpcional = (typeof MODULOS_OPCIONAIS)[number];

/** Os módulos de tabela do ADR-0002 dentro de `MODULOS_OPCIONAIS` — resolvidos por
 * `modulos_instalados.estado = 'ativo'`, nunca por `platform_config`. */
const MODULOS_DE_TABELA = ["honorarios"] as const satisfies readonly ModuloOpcional[];

/**
 * Só os módulos por FLAG — os que a tela `/admin/sistema` liga e desliga via
 * `updateModuloDaInstalacao`. Um módulo de tabela NUNCA entra aqui: ele se instala por
 * `fn_modulo_instalar` (`/admin/modulos`), e deixá-lo passar pelo Zod desse action tentaria
 * gravar em `platform_config` com uma chave que não existe — silenciosamente, porque
 * `CHAVE_DO_MODULO[modulo]` seria `undefined`.
 */
export const MODULOS_OPCIONAIS_POR_FLAG = ["banco_externo"] as const satisfies readonly ModuloOpcional[];

/** A linha de cada módulo por FLAG em `platform_config`. O formato é o da CHECK da 0341.
 * Não inclui os módulos de tabela — esses vêm de `modulos_instalados`. */
export const CHAVE_DO_MODULO: Record<(typeof MODULOS_OPCIONAIS_POR_FLAG)[number], string> = {
  banco_externo: "MODULO_BANCO_EXTERNO",
};

const LIGADO = "ligado";
const DESLIGADO = "desligado";

/** Os módulos ligados nesta instalação, dos dois mecanismos. Nunca lança: erro de banco =
 * nenhum módulo daquele mecanismo — falha fechada, os dois lados. */
export async function modulosLigados(db: SupabaseClient): Promise<ModuloOpcional[]> {
  const [porFlag, porTabela] = await Promise.all([
    modulosLigadosPorFlag(db),
    modulosDeTabelaAtivos(db),
  ]);
  return [...porFlag, ...porTabela];
}

async function modulosLigadosPorFlag(
  db: SupabaseClient,
): Promise<Array<(typeof MODULOS_OPCIONAIS_POR_FLAG)[number]>> {
  try {
    const { data, error } = await db
      .from("platform_config")
      .select("chave, valor")
      .in("chave", Object.values(CHAVE_DO_MODULO));
    if (error) {
      logger.warn("módulos da instalação: leitura recusada — tratando todos como desligados", {
        codigo: error.code,
        detalhe: error.message,
      });
      return [];
    }
    const linhas = (data ?? []) as Array<{ chave: string; valor: string | null }>;
    return MODULOS_OPCIONAIS_POR_FLAG.filter((m) =>
      linhas.some((l) => l.chave === CHAVE_DO_MODULO[m] && l.valor === LIGADO),
    );
  } catch (erro) {
    logger.warn("módulos da instalação: leitura falhou — tratando todos como desligados", {
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return [];
  }
}

async function modulosDeTabelaAtivos(
  db: SupabaseClient,
): Promise<Array<(typeof MODULOS_DE_TABELA)[number]>> {
  try {
    const { data, error } = await db
      .from("modulos_instalados")
      .select("modulo, estado")
      .in("modulo", MODULOS_DE_TABELA)
      .eq("estado", "ativo");
    if (error) {
      // A tabela nasce na migration 0340, que já é antiga; um 42P01 aqui só aconteceria num
      // banco anterior a ela, e falhar fechado (nenhum módulo de tabela ativo) é o correto.
      logger.warn("módulos de tabela: leitura recusada — tratando todos como desligados", {
        codigo: error.code,
        detalhe: error.message,
      });
      return [];
    }
    const linhas = (data ?? []) as Array<{ modulo: string }>;
    return MODULOS_DE_TABELA.filter((m) => linhas.some((l) => l.modulo === m));
  } catch (erro) {
    logger.warn("módulos de tabela: leitura falhou — tratando todos como desligados", {
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return [];
  }
}

export async function moduloLigado(db: SupabaseClient, modulo: ModuloOpcional): Promise<boolean> {
  return (await modulosLigados(db)).includes(modulo);
}

/**
 * Grava a escolha de quem administra a instalação. `semeado_do_env = false`
 * pela regra da 0341: foi uma pessoa, e nada sobrescreve.
 */
export async function gravarModulo(
  db: SupabaseClient,
  modulo: (typeof MODULOS_OPCIONAIS_POR_FLAG)[number],
  ligado: boolean,
  ator: string,
): Promise<boolean> {
  const { error } = await db.from("platform_config").upsert(
    {
      chave: CHAVE_DO_MODULO[modulo],
      valor: ligado ? LIGADO : DESLIGADO,
      eh_segredo: false,
      semeado_do_env: false,
      updated_by: ator,
    },
    { onConflict: "chave" },
  );
  if (error) {
    logger.error("módulos da instalação: não deu para gravar", {
      modulo,
      codigo: error.code,
      detalhe: error.message,
    });
    return false;
  }
  return true;
}
