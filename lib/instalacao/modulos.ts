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

export const MODULOS_OPCIONAIS = ["banco_externo"] as const;
export type ModuloOpcional = (typeof MODULOS_OPCIONAIS)[number];

/** A linha de cada módulo em `platform_config`. O formato é o da CHECK da 0341. */
export const CHAVE_DO_MODULO: Record<ModuloOpcional, string> = {
  banco_externo: "MODULO_BANCO_EXTERNO",
};

const LIGADO = "ligado";
const DESLIGADO = "desligado";

/** Os módulos ligados nesta instalação. Nunca lança: erro de banco = nenhum. */
export async function modulosLigados(db: SupabaseClient): Promise<ModuloOpcional[]> {
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
    return MODULOS_OPCIONAIS.filter((m) =>
      linhas.some((l) => l.chave === CHAVE_DO_MODULO[m] && l.valor === LIGADO),
    );
  } catch (erro) {
    logger.warn("módulos da instalação: leitura falhou — tratando todos como desligados", {
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
  modulo: ModuloOpcional,
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
