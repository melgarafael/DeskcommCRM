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
import type pg from "pg";

import { logger } from "@/lib/logger";

/**
 * `banco_externo`, `fluxos_atendimento`, `propostas`, `crm_b2b`, `cobranca` e `login_codex` ligam/desligam por uma linha em `platform_config`
 * (ver o resto deste arquivo). `honorarios` é um MÓDULO DE TABELA (ADR-0002): a fonte da
 * verdade é `modulos_instalados`, escrita só por `fn_modulo_instalar` (`lib/modulos/service.ts`),
 * nunca por esta tela. Os dois mecanismos convivem na mesma lista porque é isso que
 * `deModuloDesligado` (catálogo de tools MCP) precisa: "este módulo, seja qual for o mecanismo
 * por trás, está ligado nesta instalação?".
 */
export const MODULOS_OPCIONAIS = [
  "banco_externo",
  "fluxos_atendimento",
  "propostas",
  "crm_b2b",
  "honorarios",
  "cobranca",
  "login_codex",
] as const;
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
export const MODULOS_OPCIONAIS_POR_FLAG = [
  "banco_externo",
  "fluxos_atendimento",
  "propostas",
  "crm_b2b",
  "cobranca",
  "login_codex",
] as const satisfies readonly ModuloOpcional[];

/** A linha de cada módulo por FLAG em `platform_config`. O formato é o da CHECK da 0341.
 * Não inclui os módulos de tabela — esses vêm de `modulos_instalados`. */
export const CHAVE_DO_MODULO: Record<(typeof MODULOS_OPCIONAIS_POR_FLAG)[number], string> = {
  banco_externo: "MODULO_BANCO_EXTERNO",
  // Doc 64 (a): os fluxos de atendimento do #1130 entram desligados. A IA passa
  // a conduzir um roteiro de perguntas no turno — quem não liga não carrega o
  // caminho novo (`lib/agent-engine/agent/roteiro-no-turno.ts`).
  fluxos_atendimento: "MODULO_FLUXOS_DE_ATENDIMENTO",
  // Doc 79 (b): a proposta comercial do #1832 tem DUAS chaves — esta, de quem
  // administra o servidor (quem revende decide se oferece), e a de cada
  // empresa em Configurações › Propostas. Desligada aqui, nenhuma empresa vê
  // nem liga (`lib/organizacao/capacidades.ts` exige as duas).
  propostas: "MODULO_PROPOSTAS",
  // Doc 68 (b): empresas, pessoas que decidem e importação de planilha — a
  // metade B2B do #1621. A maior parte de quem usa vende para pessoas; quem
  // vende para empresas liga. Desligado, as telas e as rotas somem (404).
  crm_b2b: "MODULO_CRM_B2B",
  // Spec da cobrança do revendedor (§1.2, D-1): capacidade do NÚCLEO com chave
  // da instalação. As tabelas `cobranca_*` existem em todo banco, vazias; a
  // chave decide se valem. Desligada: rotas 404, limites "sem limite", cron pula.
  cobranca: "MODULO_COBRANCA",
  // #1639: o login do Codex por assinatura. Desligado por padrão é a condição
  // que o mantenedor pôs (02/10): só quem administra a instalação liga, e
  // ligar libera o painel de conexão em /admin/sistema.
  login_codex: "MODULO_LOGIN_CODEX",
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

/**
 * A chave da COBRANÇA com o mesmo memo, para quem só tem o pool `pg`: o gate do
 * LLM (lib/agent-engine/edge/llm/run-model-call.ts), que roda em TODA chamada
 * com a chave da instalação. Lê pela função que o próprio `fn_limite_do_plano`
 * consulta. Erro = desligada: o teto do plano não roda e a chamada segue — o
 * mesmo lado de `lerTetoDoPlano` indisponível.
 */
export async function cobrancaLigadaComMemo(
  db: Pick<pg.Pool, "query">,
  agora: number = Date.now(),
): Promise<boolean> {
  const memo = memoDoModulo.get("cobranca");
  if (memo !== undefined && memo.ate > agora) return memo.ligado;
  let ligado = false;
  try {
    const { rows } = await db.query<{ ligada: boolean }>("select public.fn_cobranca_ligada() as ligada");
    ligado = rows[0]?.ligada === true;
  } catch (erro) {
    logger.warn("módulos da instalação: leitura da cobrança falhou — tratando como desligada", {
      codigo: (erro as { code?: unknown } | null)?.code,
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
  }
  memoDoModulo.set("cobranca", { ligado, ate: agora + MEMO_DO_MODULO_MS });
  return ligado;
}

/** Só para teste: esquece o memo. */
export function esquecerMemoDosModulos(): void {
  memoDoModulo.clear();
}

/**
 * Módulos que existem no código mas ainda NÃO podem ser ligados por quem opera
 * (a capacidade chega em partes e o que a torna usável ainda não entrou).
 * Vazia desde a PR 3a da cobrança do revendedor, que trouxe o provedor de
 * pagamento. O mecanismo fica: a próxima capacidade entregue em partes o usa.
 */
export const MODULOS_AINDA_NAO_LIGAVEIS: readonly ModuloOpcional[] = [];

/**
 * Módulos que são decisão SÓ de quem administra o servidor e não aparecem para a
 * empresa em Configurações › Recursos opcionais. "Cobrança dos seus clientes —
 * Desligado por quem administra o servidor" diria à empresa que ela pode pedir
 * para ser cobrada (spec da cobrança §9).
 */
export const MODULOS_SO_DA_INSTALACAO: readonly ModuloOpcional[] = ["cobranca"];

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
