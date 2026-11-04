/**
 * O webhook ÚNICO da instalação: um endpoint no provedor para todos os números
 * conectados com um clique, em vez de uma assinatura por número.
 *
 * ─── Por que um só ──────────────────────────────────────────────────────────
 *
 * O provedor limita as assinaturas por conta (50 por usuário na referência da
 * API; a guia de multi-cliente falava em 10) e recomenda, para quem atende
 * vários clientes, UM endpoint que roteia por conta. Com uma assinatura por
 * número, a conta da instalação — que pode ser compartilhada com outros
 * sistemas do mesmo dono — esgotava o teto em poucas dezenas de clientes.
 *
 * ─── O filtro é por PERFIL ──────────────────────────────────────────────────
 *
 * Cada organização tem o seu perfil (`garantirPerfil`), e o webhook só recebe os
 * perfis das conexões de um clique ativas. A documentação do provedor manda
 * preferir perfis: o id da conta muda quando a conta é reconectada, o do perfil
 * não. É também o que separa estes eventos dos de outros sistemas que usam a
 * mesma conta do provedor.
 *
 * ⚠️ LISTA VAZIA, NO PROVEDOR, QUER DIZER "TODOS OS PERFIS". Sem nenhuma conexão
 * ativa, o webhook é DESLIGADO (`isActive: false`), nunca atualizado com `[]`:
 * isso o abriria para todas as contas da instalação.
 *
 * ⚠️ O FILTRO ACEITA NO MÁXIMO 50 PERFIS (`profileIds`, items <= 50 na
 * referência da API). Passou disso, a assinatura fica SEM filtro — recebe todos
 * os perfis da conta — em vez de ser recusada: com a recusa, nenhuma conexão
 * nova entraria. É o desenho que o provedor recomenda para quem atende muitos
 * clientes, e a entrada da instalação já descarta, com 200 e sem gravar nada,
 * todo evento que não é de uma conexão de um clique ativa.
 *
 * ─── O segredo ──────────────────────────────────────────────────────────────
 *
 * Gerado uma vez e guardado cifrado em `platform_config`, sem passar pela tela
 * (fora do catálogo: ninguém precisa vê-lo nem trocá-lo à mão). É ele que a rota
 * de entrada da instalação confere em cada entrega.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { logger } from "@/lib/logger";
import { gravarPelaTela, gravarSeAusente, valorDaInstalacao } from "@/lib/instalacao/config";

import { CHANNEL_PROVIDER_ZERNIO } from "../capabilities";
import { socialRequest as pedirAoProvedor } from "../social/client";
import { EVENTOS_DO_WEBHOOK, apagarWebhook } from "./conexao-pela-instalacao";

export const CHAVE_DO_SEGREDO = "ZERNIO_PLATFORM_WEBHOOK_SECRET";
export const CHAVE_DO_ID = "ZERNIO_PLATFORM_WEBHOOK_ID";

/** Teto do provedor para `profileIds` numa assinatura. */
export const MAXIMO_DE_PERFIS_NO_FILTRO = 50;

/** Onde o provedor entrega. Público, sem token: quem autentica é a assinatura. */
export const CAMINHO_DA_ENTRADA_DA_INSTALACAO = "/api/v1/webhooks/canal-da-instalacao";

/** O segredo em vigor, ou `null` quando a instalação ainda não registrou o webhook. */
export async function segredoDoWebhookDaInstalacao(): Promise<string | null> {
  return (await valorDaInstalacao(CHAVE_DO_SEGREDO)).valor;
}

/** O id da assinatura que a instalação registrou, ou `null`. */
export async function idDoWebhookDaInstalacao(): Promise<string | null> {
  return (await valorDaInstalacao(CHAVE_DO_ID)).valor;
}

/** O segredo, gerado na primeira vez. `novo` = acabou de nascer (nenhuma assinatura o conhece). */
async function garantirSegredo(): Promise<{ segredo: string; novo: boolean }> {
  const atual = await segredoDoWebhookDaInstalacao();
  if (atual) return { segredo: atual, novo: false };
  const gerado = randomBytes(32).toString("hex");
  const ficou = await gravarSeAusente(CHAVE_DO_SEGREDO, gerado, { ehSegredo: true });
  if (!ficou)
    throw new Error("o segredo do webhook da instalação não foi gravado (cifra indisponível?)");
  return { segredo: ficou, novo: true };
}

/**
 * Os perfis das conexões de um clique ATIVAS, ordenados e sem repetição. A
 * sessão que está saindo (`excluirSessao`) já não conta: a remoção recalcula o
 * filtro antes de arquivar a linha.
 */
export async function perfisDaInstalacao(
  admin: SupabaseClient,
  excluirSessao?: string,
): Promise<string[]> {
  let consulta = admin
    .from("channel_sessions")
    .select("id, zernio_profile_id")
    .eq("provider", CHANNEL_PROVIDER_ZERNIO)
    .eq("zernio_credencial_da_instalacao", true)
    .is("archived_at", null)
    .not("zernio_profile_id", "is", null);
  if (excluirSessao) consulta = consulta.neq("id", excluirSessao);
  const { data, error } = await consulta;
  if (error) throw new Error(`conexões da instalação não lidas: ${error.message}`);
  const perfis = ((data ?? []) as { zernio_profile_id: string }[]).map((l) => l.zernio_profile_id);
  return [...new Set(perfis)].sort();
}

const webhooksSchema = z.object({
  webhooks: z.array(
    z.object({ _id: z.string(), url: z.string(), isActive: z.boolean().optional() }),
  ),
});

interface Alvo {
  /** Presente: cria a assinatura se faltar e mantém a URL em dia. Ausente (remoção): só ajusta a que existe. */
  url?: string;
  nome: string;
}

/** Uma passada: deixa a assinatura no provedor com ESTES perfis. Devolve o id, ou `null` se não há assinatura. */
async function aplicar(
  chave: string,
  alvo: Alvo,
  segredo: { valor: string; novo: boolean },
  perfis: string[],
): Promise<string | null> {
  const { webhooks } = webhooksSchema.parse(await pedirAoProvedor(chave, "webhooks/settings"));
  const gravado = await idDoWebhookDaInstalacao();
  let achada =
    webhooks.find((w) => w._id === gravado) ??
    (alvo.url ? webhooks.find((w) => w.url === alvo.url) : undefined);

  // Segredo recém-gerado e uma assinatura antiga na mesma URL: ela assina com um
  // segredo que ninguém mais tem, e toda entrega seria recusada. Sai e nasce outra.
  if (achada && segredo.novo) {
    await apagarWebhook(chave, achada._id);
    achada = undefined;
  }

  if (perfis.length === 0) {
    if (achada && achada.isActive !== false) {
      await pedirAoProvedor(
        chave,
        "webhooks/settings",
        { webhookId: achada._id, isActive: false },
        "PUT",
      );
    }
    return achada?._id ?? null;
  }

  // Acima do teto, sem filtro (lista vazia = todos os perfis): ver o cabeçalho.
  const filtro = perfis.length > MAXIMO_DE_PERFIS_NO_FILTRO ? [] : perfis;
  if (filtro.length === 0) {
    logger.warn("[webhook-da-instalacao] mais perfis que o teto do filtro; assinatura sem filtro", {
      perfis: perfis.length,
      teto: MAXIMO_DE_PERFIS_NO_FILTRO,
    });
  }

  let id: string;
  if (achada) {
    await pedirAoProvedor(
      chave,
      "webhooks/settings",
      {
        webhookId: achada._id,
        profileIds: filtro,
        isActive: true,
        ...(alvo.url ? { url: alvo.url } : {}),
      },
      "PUT",
    );
    id = achada._id;
  } else {
    if (!alvo.url) return null;
    const criada = z.object({ webhook: z.object({ _id: z.string() }) }).parse(
      await pedirAoProvedor(chave, "webhooks/settings", {
        name: alvo.nome.slice(0, 50),
        url: alvo.url,
        secret: segredo.valor,
        events: [...EVENTOS_DO_WEBHOOK],
        profileIds: filtro,
        isActive: true,
      }),
    );
    id = criada.webhook._id;
  }
  if (id !== gravado) {
    const r = await gravarPelaTela(CHAVE_DO_ID, id, { ehSegredo: false, ator: null });
    if (!r.ok)
      logger.warn("[webhook-da-instalacao] id da assinatura não gravado", { motivo: r.motivo });
  }
  return id;
}

/**
 * Deixa o webhook da instalação com os perfis das conexões ativas. Recalcula
 * depois de escrever e repete (até 3 vezes) se outra conexão entrou ou saiu no
 * meio: o filtro é sempre o da base, nunca o de quem escreveu por último.
 *
 * Devolve o id da assinatura que entrega (ou `null` quando ficou desligada por
 * falta de conexões). Erro do provedor LANÇA; quem chama decide o que fazer.
 */
export async function sincronizarWebhookDaInstalacao(
  admin: SupabaseClient,
  chave: string,
  alvo: Alvo & { excluirSessao?: string },
): Promise<string | null> {
  const { segredo, novo } = await garantirSegredo();
  let perfis = await perfisDaInstalacao(admin, alvo.excluirSessao);
  let id: string | null = null;
  for (let passada = 0; passada < 3; passada++) {
    id = await aplicar(chave, alvo, { valor: segredo, novo: novo && passada === 0 }, perfis);
    const depois = await perfisDaInstalacao(admin, alvo.excluirSessao);
    if (depois.join() === perfis.join()) return perfis.length ? id : null;
    perfis = depois;
  }
  logger.warn(
    "[webhook-da-instalacao] conexões mudando durante a sincronização; a próxima corrige",
    {
      perfis: perfis.length,
    },
  );
  return perfis.length ? id : null;
}
