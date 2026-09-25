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

export const MODULOS_OPCIONAIS = ["banco_externo", "fluxos_atendimento"] as const;
export type ModuloOpcional = (typeof MODULOS_OPCIONAIS)[number];

/** A linha de cada módulo em `platform_config`. O formato é o da CHECK da 0341. */
export const CHAVE_DO_MODULO: Record<ModuloOpcional, string> = {
  banco_externo: "MODULO_BANCO_EXTERNO",
  // Doc 64 (a): os fluxos de atendimento do #1130 entram desligados. A IA passa
  // a conduzir um roteiro de perguntas no turno — quem não liga não carrega o
  // caminho novo (`lib/agent-engine/agent/roteiro-no-turno.ts`).
  fluxos_atendimento: "MODULO_FLUXOS_DE_ATENDIMENTO",
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
 * Quanto tempo o turno do agente confia na última leitura da chave. O motor lia
 * `platform_config` a cada mensagem recebida (revisão do PR 1 dos fluxos:
 * +1 ida ao banco por turno, em toda instalação, para a minoria que liga o
 * módulo). O custo do memo: desligar a chave vale para o turno em até 30 s.
 */
export const MEMO_DO_MODULO_MS = 30_000;

const memoDoModulo = new Map<ModuloOpcional, { ligado: boolean; ate: number }>();

/**
 * `moduloLigado` com memo de processo — para o caminho QUENTE (o turno do
 * agente). Telas e rotas seguem lendo o banco a cada vez.
 */
export async function moduloLigadoComMemo(
  db: SupabaseClient,
  modulo: ModuloOpcional,
  agora: number = Date.now(),
): Promise<boolean> {
  const memo = memoDoModulo.get(modulo);
  if (memo !== undefined && memo.ate > agora) return memo.ligado;
  const ligado = await moduloLigado(db, modulo);
  memoDoModulo.set(modulo, { ligado, ate: agora + MEMO_DO_MODULO_MS });
  return ligado;
}

/** Só para teste: esquece o memo. */
export function esquecerMemoDosModulos(): void {
  memoDoModulo.clear();
}

/**
 * Módulos que existem no código mas ainda NÃO podem ser ligados por quem opera
 * (a capacidade chega em partes e a tela que a torna usável ainda não entrou).
 * Vazia: os roteiros de atendimento ganharam tela no PR 3 do port do #1130.
 */
export const MODULOS_AINDA_NAO_LIGAVEIS: readonly ModuloOpcional[] = [];

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
