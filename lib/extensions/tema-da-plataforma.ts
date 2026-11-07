/**
 * O TEMA DA PLATAFORMA (#3790): a paleta de uma extensão aplicada à INSTALAÇÃO
 * inteira — login, `/admin` e as organizações que não escolheram tema.
 *
 * ── Por que existe, se já existe tema por organização ───────────────────────
 *
 * O tema de extensão nasceu por organização (#1095) e só alcança o `/app` de
 * quem escolheu, porque o marcador `[data-tema-extensao]` é emitido por
 * `app/app/layout.tsx` e o CSS é escopado por `body:has(...)`. Fora dali —
 * login, `/admin`, organizações sem tema — a paleta de fábrica fica intacta,
 * mesmo com a marca aplicada na tela Marca. Medido numa 1.96.0: bordas
 * `#e7e3da`, campos `#faf9f6` e texto em cinza quente dentro do `/admin`.
 *
 * ── O que é gravado, e o que NÃO é ─────────────────────────────────────────
 *
 * Grava-se o **id da instalação da extensão** em `platform_config`
 * (`APP_TEMA_DA_PLATAFORMA`), não o CSS (DIRC: calcular, não armazenar). Assim,
 * atualizar a extensão, desfazer a atualização ou removê-la chega à plataforma
 * sem passo extra — e remover a instalação DESLIGA o tema sozinho, porque a
 * leitura confere que a instalação ainda existe e não foi removida.
 *
 * ── Duas fontes, uma cor ───────────────────────────────────────────────────
 *
 * O CSS sai de `cssDaExtensaoDeTema` com `ESCOPO_DA_INSTALACAO` (`:root:root`),
 * e as chaves `--color-accent*` são DESCARTADAS (`semAsChavesDaCorDeAcao`): a
 * cor de ação continua vindo da tela Marca, que já resolve banco + `.env` com
 * conferência de contraste. O tema pinta superfícies, bordas e textos.
 *
 * ── O contrato de leitura: nunca lança, e falha é paleta de fábrica ────────
 *
 * Este módulo é lido em `app/layout.tsx` — TODA tela, inclusive o login. Um
 * throw ali é 500 na tela onde alguém corrigiria o problema, então falha de
 * banco, de parse ou de manifesto degrada para "sem `<style>`", com aviso no
 * log. O memo de processo segue o do CSS personalizado
 * (`lib/branding/css-personalizado.ts`): TTL curto, guarda de geração contra a
 * leitura em voo que ressuscitaria o valor pré-escrita, e **erro FORA do
 * memo** — senão uma falha de transporte vira fato por um TTL inteiro.
 */
import { logger } from "@/lib/logger";
import { valorDaInstalacao } from "@/lib/instalacao/config";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  cssDaExtensaoDeTema,
  ESCOPO_DA_INSTALACAO,
  esquemaDaContribuicaoDeTema,
  semAsChavesDaCorDeAcao,
  type TemaDeExtensao,
} from "./tema";

/** A chave em `platform_config`. O valor é o id da INSTALAÇÃO da extensão. */
export const CHAVE_TEMA_DA_PLATAFORMA = "APP_TEMA_DA_PLATAFORMA";

const TTL_MEMO_MS = 30_000;

/**
 * Quantas instalações a tela Marca oferece como tema. O mesmo teto do
 * `lib/extensions/service.ts` para a lista de instaladas (128); aqui só as que
 * declaram tema entram, e a tela é de seleção, não de inventário.
 */
const LIMITE_DE_INSTALACOES = 128;

/** Uma extensão instalada que oferece um tema — o que o seletor mostra. */
export type TemaInstalado = {
  readonly instalacaoId: string;
  /** `publicador/nome` — o rótulo que a tela de extensões já usa. */
  readonly rotulo: string;
  readonly versao: string;
  readonly tema: TemaDeExtensao;
};

/**
 * A coluna aninhada: o manifesto mora no ARTEFATO da instalação, e é dele que
 * sai `contributions.theme` (o mesmo caminho de `app/app/layout.tsx`). O
 * manifesto gravado é revalidado aqui — um pacote velho ou adulterado não pinta
 * o produto sem passar pela régua de forma dos valores.
 */
// ⚠️ Literal de UMA linha, e não concatenação: o cliente tipado do Supabase
// infere o formato do retorno pelo TIPO do literal. Concatenar duas strings
// alarga para `string`, e o retorno vira `GenericStringError` — o `tsc` acusa
// em cada coluna lida, e o erro parece de banco quando é de inferência.
const SELECT_DA_INSTALACAO =
  "id,publisher,name,version,removed_at,extension_artifacts!extension_installations_artifact_id_fkey(manifest)" as const;

function temaDoManifesto(manifest: unknown): TemaDeExtensao | null {
  if (typeof manifest !== "object" || manifest === null) return null;
  const contribuicoes = (manifest as Record<string, unknown>).contributions;
  if (typeof contribuicoes !== "object" || contribuicoes === null) return null;
  const bruto = (contribuicoes as Record<string, unknown>).theme;
  if (bruto === undefined) return null;
  const tema = esquemaDaContribuicaoDeTema.safeParse(bruto);
  return tema.success ? tema.data : null;
}

function doArtefato(valor: unknown): unknown {
  const artefato = Array.isArray(valor) ? valor[0] : valor;
  if (typeof artefato !== "object" || artefato === null) return null;
  return (artefato as Record<string, unknown>).manifest;
}

/**
 * As extensões instaladas que oferecem tema, para o seletor de `/admin/marca`.
 *
 * Leitura de PLATAFORMA (`extension_installations` não tem `organization_id`),
 * com o mesmo filtro de soft delete das irmãs: linha com `removed_at` é
 * extensão que o operador já removeu e não pode ser oferecida como tema.
 *
 * Não lança: a tela que configura o tema não pode cair por causa da lista. Em
 * falha devolve lista vazia — que a tela relata como "nenhum tema instalado".
 */
export async function temasInstaladosDaPlataforma(): Promise<readonly TemaInstalado[]> {
  try {
    const { data, error } = await createAdminClient()
      .from("extension_installations")
      .select(SELECT_DA_INSTALACAO)
      .is("removed_at", null)
      .order("installed_at", { ascending: false })
      .limit(LIMITE_DE_INSTALACOES);
    if (error) {
      logger.warn("tema da plataforma: a lista de extensões instaladas não foi lida", {
        codigo: "platform_theme_list_failed",
      });
      return [];
    }
    const temas: TemaInstalado[] = [];
    for (const linha of data ?? []) {
      const tema = temaDoManifesto(doArtefato(linha.extension_artifacts));
      if (tema === null) continue;
      temas.push({
        instalacaoId: linha.id,
        rotulo: `${linha.publisher}/${linha.name}`,
        versao: linha.version,
        tema,
      });
    }
    return temas;
  } catch (erro) {
    logger.warn("tema da plataforma: a lista de extensões instaladas não foi lida", {
      codigo: "platform_theme_list_failed",
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return [];
  }
}

/**
 * A instalação escolhida para a plataforma, ou `null` quando ninguém escolheu
 * (o caso comum: sem linha em `platform_config`).
 */
export async function idDoTemaDaPlataforma(): Promise<string | null> {
  try {
    const { valor } = await valorDaInstalacao(CHAVE_TEMA_DA_PLATAFORMA);
    const id = valor?.trim();
    return id ? id : null;
  } catch (erro) {
    logger.warn("tema da plataforma: a escolha não foi lida", {
      codigo: "platform_theme_read_failed",
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return null;
  }
}

export type ConferenciaDoTema =
  | { readonly ok: true; readonly tema: TemaDeExtensao }
  | { readonly ok: false; readonly motivo: "nao_instalada" | "sem_tema" | "banco_indisponivel" };

/**
 * A GUARDA DA AÇÃO: confere no BANCO que a instalação existe, não foi removida
 * e traz um tema válido.
 *
 * A tela oferece uma lista, mas lista é sugestão de interface — a ação não pode
 * gravar um id arbitrário que chegou no payload. Mesmo argumento das guardas do
 * CSS personalizado: quem grava valida o que grava, e a tela é conveniência.
 *
 * `banco_indisponivel` é separado de `nao_instalada` de propósito: a primeira é
 * falha de transporte (tentar de novo resolve), a segunda é escolha inválida
 * (tentar de novo não resolve). A mensagem da tela difere.
 */
export async function conferirTemaDaPlataforma(instalacaoId: string): Promise<ConferenciaDoTema> {
  let data: unknown;
  try {
    const resposta = await createAdminClient()
      .from("extension_installations")
      .select(SELECT_DA_INSTALACAO)
      .eq("id", instalacaoId)
      .is("removed_at", null)
      .maybeSingle();
    if (resposta.error) {
      logger.warn("tema da plataforma: a instalação escolhida não foi conferida", {
        codigo: "platform_theme_check_failed",
      });
      return { ok: false, motivo: "banco_indisponivel" };
    }
    data = resposta.data;
  } catch (erro) {
    logger.warn("tema da plataforma: a instalação escolhida não foi conferida", {
      codigo: "platform_theme_check_failed",
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return { ok: false, motivo: "banco_indisponivel" };
  }

  if (typeof data !== "object" || data === null) return { ok: false, motivo: "nao_instalada" };
  const tema = temaDoManifesto(doArtefato((data as Record<string, unknown>).extension_artifacts));
  if (tema === null) return { ok: false, motivo: "sem_tema" };
  return { ok: true, tema };
}

type CacheDoTema = {
  readonly css: string | null;
  readonly expiraEm: number;
};
type EstadoGlobal = typeof globalThis & {
  __temaDaPlataformaDaInstalacao?: CacheDoTema;
  __geracaoTemaDaPlataformaDaInstalacao?: number;
};

/**
 * Lê o CSS do tema escolhido direto do banco. Devolve o texto montado, ou
 * `null` quando não há escolha/instalação/tema. Erro é `null` com aviso — e NÃO
 * entra no memo (ver o cabeçalho do módulo).
 */
async function lerDoBanco(): Promise<{
  readonly css: string | null;
  readonly memoizavel: boolean;
}> {
  const id = await idDoTemaDaPlataforma();
  if (id === null) return { css: null, memoizavel: true };

  const conferencia = await conferirTemaDaPlataforma(id);
  if (!conferencia.ok) {
    // Instalação removida ou sem tema é ESCOLHA que envelheceu — memoizável
    // (a leitura seguinte responde o mesmo) —, mas falha de transporte não é.
    const memoizavel = conferencia.motivo !== "banco_indisponivel";
    if (memoizavel) {
      logger.warn("tema da plataforma: a escolha gravada não vale mais; paleta de fábrica", {
        codigo: "platform_theme_stale",
        motivo: conferencia.motivo,
      });
    }
    return { css: null, memoizavel };
  }

  // `semAsChavesDaCorDeAcao` ANTES do construtor: as chaves de accent não têm
  // dono aqui (a cor de ação é da tela Marca), e filtrar depois de montar
  // deixaria o bloco com um `--color-accent` que ninguém quer.
  const { css, motivos } = cssDaExtensaoDeTema(
    semAsChavesDaCorDeAcao(conferencia.tema),
    ESCOPO_DA_INSTALACAO,
  );
  if (motivos.length > 0) {
    logger.warn("tema da plataforma: o tema escolhido não foi aplicado como está", {
      codigo: "platform_theme_refused",
      motivos,
    });
    return { css: null, memoizavel: true };
  }
  return { css, memoizavel: true };
}

async function lerMemoizado(): Promise<string | null> {
  const global = globalThis as EstadoGlobal;
  const atual = global.__temaDaPlataformaDaInstalacao;
  if (atual && atual.expiraEm > Date.now()) return atual.css;

  const geracao = global.__geracaoTemaDaPlataformaDaInstalacao ?? 0;
  const { css, memoizavel } = await lerDoBanco();
  // Guarda de geração: a escrita invalidou o memo ENQUANTO esta leitura estava
  // em voo, e gravar agora ressuscitaria o valor de antes da escrita.
  if (memoizavel && (global.__geracaoTemaDaPlataformaDaInstalacao ?? 0) === geracao) {
    global.__temaDaPlataformaDaInstalacao = { css, expiraEm: Date.now() + TTL_MEMO_MS };
  }
  return css;
}

/**
 * O CSS do tema da plataforma para o `<style>` do layout raiz, ou `null`.
 *
 * NUNCA lança: roda em `app/layout.tsx`. `desligada` é o `?sem_css=1` — o mesmo
 * interruptor do CSS personalizado, e pelo mesmo motivo: quem está depurando um
 * problema visual precisa ver o produto sem as folhas que a instalação aplicou.
 */
export async function cssDoTemaDaPlataforma(desligada: boolean): Promise<string | null> {
  if (desligada) return null;
  try {
    return await lerMemoizado();
  } catch (erro) {
    logger.warn("tema da plataforma: indisponível; paleta de fábrica", {
      codigo: "platform_theme_unavailable",
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return null;
  }
}

/** Chamado pela ação depois de gravar: a próxima tela relê do banco. */
export function invalidarTemaDaPlataforma(): void {
  const global = globalThis as EstadoGlobal;
  global.__geracaoTemaDaPlataformaDaInstalacao =
    (global.__geracaoTemaDaPlataformaDaInstalacao ?? 0) + 1;
  delete global.__temaDaPlataformaDaInstalacao;
}
