/**
 * Consome `media.derive_requested`: baixa a mídia persistida (Onda 0), gera o
 * derivado textual model-agnóstico (transcrição/visão/pdf) e grava em
 * messages.media_derived_text. Camada UNIVERSAL da Onda 3 — o texto alimenta
 * qualquer modelo de chat. Retry/backoff delegados ao drain (padrão do repo).
 */
import { generateText } from "ai";
import type pg from "pg";

import { extractPdfText } from "@/lib/ai/rag/extractors/pdf";
import { visaoEmVigor } from "@/lib/ai/pontos/capacidade-em-vigor";
import { resolveOrgLlmConfig, type LlmEdgeConfig } from "@/lib/agent-engine/edge/llm/credentials";
import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { createPool } from "@/lib/agent-engine/db/pool";
import { env } from "@/lib/env";
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { deriveMediaText, type DeriveDeps } from "@/lib/messaging/media/derive";
import { MARCADOR_NAO_LIDA, TIPOS_DERIVAVEIS } from "@/lib/messaging/media/derivable";
import { deriveVideoText } from "@/lib/messaging/media/video-derive";
import {
  decidirTranscricao,
  type DecisaoDeTranscricao,
} from "@/lib/messaging/media/escada-de-transcricao";
import { logger } from "@/lib/logger";
import { reagirAConclusaoDeDerivacao } from "@/lib/escalacao/handoff-tecnico";
import { createAdminClient } from "@/lib/supabase/admin";
import { motivoDaRecusaDeDestino } from "@/lib/automation/destinos-internos-autorizados";
import { DETALHE_TECNICO } from "@/lib/event-log/aviso-de-evento-morto";
import { MENSAGEM_REDIGIDA } from "@/lib/lgpd/cascata";
import { avaliarPedidosFalados } from "@/workers/media-derive-worker.pedidos";

export const MEDIA_DERIVE_CONSUMER_KEY = "media_derive_v1";
const DRAIN_MAX_ATTEMPTS = 5; // espelho de lib/event-log/drain.ts

// Lista compartilhada com o drain do turno — ver lib/messaging/media/derivable.ts.

// ponytail: singleton lazy — o drain só nos dá o admin client; resolveOrgLlmConfig
// exige pg.Pool direto. Sem pool global no processo Next.js, então criamos um sob
// demanda (nunca no import). `pg.Pool` só conecta na primeira query — se
// SUPABASE_DB_URL faltar, o erro aparece ali (capturado pelo try/catch abaixo),
// não na construção.
let _pool: pg.Pool | null = null;
function derivePool(): pg.Pool {
  if (!_pool) _pool = createPool(process.env.SUPABASE_DB_URL ?? "");
  return _pool;
}

interface MessageRow {
  id: string;
  organization_id: string;
  /** A conversa da mensagem: é onde o handoff da #2210 deixa a sua marca. */
  conversation_id: string;
  type: string;
  media_mime: string | null;
  media_storage_path: string | null;
  media_derived_status: string | null;
  /**
   * Onde o motivo do `failed` mora: sem ele o operador vê o estado sem a causa.
   * É também o marcador da retenção (migration 0557, #1534): `media_status='expired'`
   * separa "arquivo que ainda vai chegar" de "arquivo que a política já retirou".
   */
  metadata: Record<string, unknown> | null;
  /** Só a mensagem ENTRADA do cliente vira pedido (#2233) — ver o guard lá embaixo. */
  direction: string | null;
  /** Áudio do atendente não é pedido nenhum: `user` e `external_device` são gente. */
  sent_via: string | null;
  /** Quando a mensagem entrou, para `aConversaAgora` comparar com o handoff. */
  created_at: string | null;
}

/**
 * Os `sent_via` de quem é PESSOA (mesma lista da consulta da #2210: quem
 * responde do inbox ou do celular). Um áudio mandado pelo atendente não é
 * pedido de nada — é conversa nossa entrando no histórico.
 */
const ENVIADO_POR_PESSOA: ReadonlySet<string> = new Set(["user", "external_device"]);

export async function deriveMessageMedia(row: EventRow): Promise<HandlerResult> {
  const consumer_key = MEDIA_DERIVE_CONSUMER_KEY;
  const messageId = (row.payload.message_id as string | undefined) ?? row.entity_id;
  if (!messageId) return { consumer_key, status: "skipped", detail: "no message_id" };

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("messages")
    .select(
      "id, organization_id, conversation_id, type, media_mime, media_storage_path, media_derived_status, metadata, direction, sent_via, created_at",
    )
    .eq("id", messageId)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  if (error) return { consumer_key, status: "error", detail: error.message };

  const msg = data as MessageRow | null;
  if (!msg) return { consumer_key, status: "skipped", detail: "no media" };

  // Desistir DE PROPÓSITO grava `skipped` (terminal em DERIVACAO_TERMINADA).
  // Sem a marca, a linha ficava com status null para sempre e o drain do turno,
  // que espera a mídia da CONVERSA, segurava a resposta do texto seguinte até o
  // teto de 120s por uma leitura que nunca ia acontecer.
  const markSkipped = async (detail: string): Promise<HandlerResult> => {
    await admin.from("messages")
      .update({ media_derived_status: "skipped" })
      .eq("id", msg.id).eq("organization_id", msg.organization_id);
    return { consumer_key, status: "skipped", detail };
  };

  // A retenção já retirou esta mídia (migration 0557, #1534): não há o que
  // derivar e, principalmente, nada a baixar do provedor — o `media_storage_path`
  // foi anulado junto, mas o DETALHE tem de dizer o motivo real, senão o turno
  // seguinte esperaria 120s por uma leitura que a política proibiu.
  if (msg.metadata?.media_status === "expired") return markSkipped("expired by retention");

  if (!msg.media_storage_path) return markSkipped("no media");
  if (msg.media_derived_status === "ready") return { consumer_key, status: "skipped", detail: "already derived" };
  if (!TIPOS_DERIVAVEIS.has(msg.type)) return { consumer_key, status: "skipped", detail: `type ${msg.type}` };
  // Vídeo é opt-in (custo: ffmpeg + N chamadas de visão): só deriva se algum agente
  // publicado da org tem video_frames_enabled=true (flag da migration 0058).
  if (msg.type === "video") {
    const { data: flag } = await admin
      .from("ai_agent_versions")
      .select("id")
      .eq("organization_id", row.organization_id)
      .eq("status", "published")
      .eq("video_frames_enabled", true)
      .limit(1)
      .maybeSingle();
    if (!flag) return markSkipped("video_frames_disabled");
  }

  /** O que o operador chama de "isto" — o aviso não pode falar em `msg.type`. */
  const rotuloDoTipo =
    ({ image: "imagem", audio: "áudio", document: "documento", video: "vídeo" } as Record<
      string,
      string
    >)[msg.type] ?? "mídia";

  // Grava o MARCADOR junto do `failed`, e é o que separa "o agente não sabe que
  // existe arquivo" de "o agente sabe que não conseguiu ler".
  //
  // Sem ele, `get-lead-context` cai no marcador de tipo — `[documento]` — que
  // diz que veio um arquivo e não diz que a leitura falhou. Medido numa VPS em
  // produção (17/09): um PDF de catálogo, sem camada de texto, falhou no
  // extrator; o agente recebeu `[documento]` e respondeu ao cliente que o
  // material "parece ser de distribuidora/promocional" — uma afirmação sobre um
  // conteúdo que ele nunca leu. As RECUSAS já entregavam este marcador há
  // tempos (`MARCADOR_NAO_LIDA`, seis caminhos); só a falha permanente não
  // entregava, e é justamente a que erra por invenção em vez de silêncio.
  //
  // O turno que já rodou não volta atrás — o dreno tem teto de espera. O que
  // isto conserta é todo turno seguinte da conversa, que lê o histórico.
  //
  // O `motivo` é o item 2 da #2171: "ninguém tentou" e "tentou e não deu"
  // eram o MESMO nulo, e o drain nem chegava aqui — ele desistia no teto de
  // 8 minutos com a coluna ainda nula. Agora todo desfecho terminal da
  // derivação é `failed` + a razão, gravada em `metadata.media_derived_motivo`,
  // que é o que o operador lê antes de sair mexendo em Provedores de IA.
  const markFailed = async (motivo: string) => {
    await admin.from("messages")
      .update({
        media_derived_text: MARCADOR_NAO_LIDA,
        media_derived_status: "failed",
        metadata: { ...(msg.metadata ?? {}), media_derived_motivo: motivo },
      })
      .eq("id", msg.id).eq("organization_id", msg.organization_id)
      // A mesma guarda LGPD do caminho `ready` (#1991): `metadata` aqui é a
      // foto lida no começo, e a anonimização que acontecer no meio a zera —
      // regravá-la devolveria à linha redigida o que a cascata apagou.
      .filter("body", "isdistinct", MENSAGEM_REDIGIDA);
  };

  try {
    const dl = await admin.storage.from("whatsapp-media").download(msg.media_storage_path);
    if (dl.error || !dl.data) throw new Error(`storage_download_failed: ${dl.error?.message ?? "no_data"}`);
    const buffer = Buffer.from(await dl.data.arrayBuffer());

    // Credencial BYOK da org p/ visão (imagem).
    const llmCfg: LlmEdgeConfig = {
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      openaiApiKey: process.env.OPENAI_API_KEY,
      // Sem esta linha, a instalação que escolheu OpenRouter no install.sh (a
      // primeira opção do menu) não tem chave nenhuma que este seam aceite:
      // toda derivação de mídia lança LlmNotConfiguredError ANTES de chegar ao
      // aviso, e o desfecho é 5 tentativas, media_derived_status='failed' e
      // ZERO avisos na Central — só um logger.error no log do contêiner.
      openrouterApiKey: process.env.OPENROUTER_API_KEY,
      cacheTtl: "1h",
    };

    // ─── O painel de provedores manda AQUI também ────────────────────────────
    //
    // `visao_de_imagem` está no registro de pontos, sem `fixo`, e fora dos
    // pontos governados pela versão publicada — ou seja, a tela o oferece como
    // editável. Enquanto este worker resolvia só pela config da organização, o
    // operador escolhia um modelo com visão, a tela dizia "salvo", a linha
    // entrava em `ai_purpose_bindings` e a descrição de imagem seguia usando o
    // modelo padrão. É textualmente a classe de defeito que
    // `lib/ai/gateway-binding.ts` declara ter vindo matar — três pontos foram
    // fechados e este ficou igual.
    //
    // ⚠️ Resolver primeiro o padrão da organização falha quando a org não tem
    // credencial padrão (ex.: onboarding com google/gemini sem chave), mesmo com
    // `visao_de_imagem` configurado e ativo com OpenAI/Anthropic (#1591). Por
    // isso, tentamos primeiro o binding de visão; se ele não existir ou falhar,
    // caímos no padrão da organização.
    const bindingDaVisao = await lerBindingDoPonto(admin, row.organization_id, "visao_de_imagem");
    // A `base_url` do binding de visão, para descer até o factory do provedor.
    //
    // ⚠️ O ponto `visao_de_imagem` aceita um endpoint próprio (é o que o painel
    // de Provedores oferece), e o TURNO DO AGENTE já o honra: `run-model-call`
    // chama `factory(config.apiKey, model, decisao.baseUrl ?? undefined)`. Aqui
    // a chamada era `factory(llm.apiKey, llm.defaultModel ?? "")`, sem o
    // terceiro argumento — então quem apontava o binding para um gateway
    // compatível via o factory cair no OPENROUTER_ENDPOINT e a derivação falhar
    // (ou pior: ir para a internet com a chave do operador), enquanto o mesmo
    // binding funcionava no chat. Um caminho só: a base_url lida aqui é a mesma
    // que o turno usa.
    let baseUrlDaVisao: string | null = null;
    let llm: Awaited<ReturnType<typeof resolveOrgLlmConfig>> | null = null;

    if (bindingDaVisao) {
      try {
        const comBinding = await resolveOrgLlmConfig(derivePool(), llmCfg, row.organization_id, {
          provider: bindingDaVisao.provider,
          credentialId: bindingDaVisao.credential_id,
        });
        llm = { ...comBinding, defaultModel: bindingDaVisao.model_id };
        // Só vale se a credencial do binding resolveu: no catch abaixo o worker
        // volta para o padrão da org, e aí o endpoint do padrão é o correto.
        baseUrlDaVisao = bindingDaVisao.base_url;
      } catch (err) {
        // Binding apontando para provedor sem chave não pode derrubar a
        // derivação inteira: cai no padrão da organização e AVISA, que é o
        // desfecho que deixa rastro em vez de silêncio.
        logger.warn("[media-derive] binding de visão sem credencial utilizável; usando o padrão da org", {
          organization_id: row.organization_id,
          provider: bindingDaVisao.provider,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!llm) {
      llm = await resolveOrgLlmConfig(derivePool(), llmCfg, row.organization_id);
    }

    // ─── DE QUEM É O OUVIDO: a escada, não a árvore de if (#2171) ──────────
    //
    // O comentário antigo — "a transcrição é SEMPRE do Whisper (api.openai.com),
    // então precisa de uma chave OpenAI" — era verdadeiro, e é justamente o
    // defeito: uma organização rodando Gemini com a chave do Google validada
    // recebia o áudio, não transcrevia, e a falha ficava MUDA. O ponto fixo
    // `transcricao_de_audio` só fala o protocolo da OpenAI; quem fala o
    // protocolo do modelo de conversa é a escada em
    // `lib/messaging/media/escada-de-transcricao.ts`, e é ela quem decide o
    // degrau. Aqui só se monta a entrada dela.
    //
    // O 401 de 09/2025 (chave da Anthropic indo para api.openai.com) continua
    // tratado: o degrau OpenAI só usa a chave do chat quando o chat É OpenAI;
    // fora disso resolve a credencial OpenAI à parte (`chaveOpenai` abaixo).
    // Só áudio e vídeo têm quem transcreva: imagem e documento não precisam
    // desta pergunta, e fazê-la à toa resolveria o padrão da organização numa
    // leitura de foto que nunca vai usar o degrau (o teste #1591 cobre justamente
    // que o binding de visão não dispare uma resolução que ninguém pediu).
    const precisaTranscricao = msg.type === "audio" || msg.type === "video";
    let conversa: Awaited<ReturnType<typeof resolveOrgLlmConfig>> | null = llm;
    if (precisaTranscricao && bindingDaVisao) {
      // O `llm` acima é o binding de VISÃO. O degrau 3 pede o modelo de
      // CONVERSA — o padrão da organização, resolvido sem override. Pode não
      // existir credencial padrão nenhuma; aí o degrau simplesmente não existe
      // e a escada devolve `nada` com o motivo, em vez de um nulo mudo.
      try {
        conversa = await resolveOrgLlmConfig(derivePool(), llmCfg, row.organization_id);
      } catch {
        conversa = null;
      }
    }

    // Thunk, não valor: a credencial OpenAI só é LIDA se o serviço de
    // transcrição da instalação (degrau 1) não valer.
    const chaveOpenai = async (): Promise<string | null> => {
      if (llm.provider === "openai") return llm.apiKey;
      try {
        const oa = await resolveOrgLlmConfig(derivePool(), llmCfg, row.organization_id, {
          provider: "openai",
        });
        return oa.apiKey;
      } catch {
        return null; // sem credencial e sem chave da instalação: nenhum degrau OpenAI
      }
    };

    // A escada roda SEMPRE: `deps.transcriber` existe para todo tipo (vídeo
    // também transcreve), e antes da escada ele era montado sem condicional.
    // O que é condicional é a PERGUNTA ao modelo de conversa — só áudio e
    // vídeo precisam de quem ouça, e uma leitura de foto não pode custar uma
    // resolução de credencial que ninguém pediu (o teste #1591 aperta exatamente
    // isso: o binding de visão resolve, e mais nada).
    const decisao: DecisaoDeTranscricao = await decidirTranscricao({
      conversa:
        precisaTranscricao && conversa
          ? { provider: conversa.provider, apiKey: conversa.apiKey, modelId: conversa.defaultModel }
          : null,
      chaveOpenai,
    });
    logger.info("[media-derive] transcrição resolvida", {
      organization_id: row.organization_id,
      origem: decisao.origem,
      motivo: decisao.motivo,
    });

    // ─── `nada` é uma RESPOSTA, não um silêncio ─────────────────────────────
    //
    // Antes: sem chave OpenAI o worker gravava um texto-marcador e seguia —
    // `media_derived_status` acabava em `ready` (ou ficava nulo, quando o
    // degrau falhava antes). Agora, para áudio sem quem transcreva, o desfecho
    // é terminal e com causa: `failed` + motivo, que é o item 2 da #2171.
    if (msg.type === "audio" && !decisao.transcriber) {
      await markFailed(decisao.motivo);
      await avisarMidiaNaoLida(
        msg.organization_id,
        rotuloDoTipo,
        decisao.motivo,
        "Cadastre a chave do provedor de conversa da organização (Provedores de IA) ou a chave OpenAI que transcreve — depois disso a próxima nota de voz volta a virar texto.",
      );
      return { consumer_key, status: "ok", detail: `transcricao_indisponivel: ${decisao.origem}` };
    }

    // ─── A chave de QUEM vai para o endereço de QUEM ────────────────────────
    //
    // `resolveOrgLlmConfig` cai na chave da INSTALAÇÃO (`.env`) quando a
    // organização não tem credencial própria ativa e validada — é o último
    // degrau da escada em `credentials.ts`. O endereço, por outro lado, é
    // escolhido por quem administra a ORGANIZAÇÃO, no painel de Provedores.
    // Juntando os dois, a chave que paga a conta de todas as empresas da
    // instalação sai para um endereço que uma delas escolheu. `motivoDaRecusaDeDestino`
    // não tem nada a dizer sobre isso: ele recusa destino INTERNO, e este caso é
    // um destino externo perfeitamente público.
    //
    // Decisão 22-a do dono do produto: endereço próprio exige chave própria.
    // Com endereço da organização e chave da instalação, a leitura é RECUSADA
    // com aviso na Central, em vez de a chave sair. Quem cadastra a credencial
    // da própria empresa segue funcionando — que é o caminho que o produto já
    // oferece na mesma tela. O turno do agente aplica o mesmo corte no seam
    // (`run-model-call.ts`).
    //
    // A origem vem do RESOLVEDOR, que é quem sabe qual degrau da escada
    // escolheu a chave. Até aqui ela era deduzida comparando o plaintext com as
    // chaves do `.env` — uma segunda cópia da escada, que o chat não tinha e que
    // divergiria no primeiro degrau novo.
    const chaveEhDaInstalacao = llm.origemDaChave === "chave_da_instalacao";

    // O 5º argumento é a `base_url` do binding: o factory precisa dela para não
    // cair no endpoint padrão do provedor (ver o comentário lá em cima).
    const deps = buildDeriveDeps(llm, decisao, row.organization_id, admin, baseUrlDaVisao, chaveEhDaInstalacao);

    const text = await deriveMediaText(msg.type, buffer, msg.media_mime ?? "application/octet-stream", deps);

    // ─── Transcrição que veio VAZIA também é `failed` + motivo (#2171) ──────
    //
    // Um provedor que responde 200 sem nada fazia o worker gravar `ready` com
    // `media_derived_text=''`: o turno seguia sem a mensagem, o operador via
    // "pronto" no painel e ninguém sabia por quê. Silêncio pro cliente com
    // status de sucesso é pior que o nulo — era o mesmo defeito de olhar.
    if (msg.type === "audio" && !text.trim()) {
      const motivo =
        `o modelo devolveu a transcrição do áudio vazia (${decisao.origem}: ${decisao.motivo})`;
      await markFailed(motivo);
      await avisarMidiaNaoLida(
        msg.organization_id,
        rotuloDoTipo,
        motivo,
        "O provedor respondeu sem texto. Confira o modelo em Provedores de IA: se ele aceita áudio mas devolve vazio, troque por outro modelo com capacidade audio.",
      );
      return { consumer_key, status: "ok", detail: "transcricao_vazia" };
    }

    // ─── LGPD: nunca gravar transcrição em mensagem já redigida (#1991) ────
    //
    // A anonimização apaga o body (vira `'[mensagem anonimizada]'`) e zera a
    // mídia. Se a virada acontece ENTRE a leitura desta mensagem e esta
    // gravação, a linha já está redigida — e este UPDATE regravaria o
    // `media_derived_text` que a cascata LGPD mandou zerar (a varredura diária
    // do passo 9 só alcança em D+1). A guarda `body IS DISTINCT FROM '[...]'`
    // faz o PostgREST casar ZERO linhas; conferimos o resultado para não
    // devolver "ok" sobre uma escrita que o banco recusou.
    //
    // `isdistinct`, nunca `neq`: áudio sem legenda tem body NULL, e
    // `NULL <> '...'` é NULL — o `neq` recusaria TODA nota de voz.
    const { data: gravados, error: erroDaGravacao } = await admin
      .from("messages")
      .update({ media_derived_text: text, media_derived_status: "ready" })
      .eq("id", msg.id)
      .eq("organization_id", msg.organization_id)
      .filter("body", "isdistinct", MENSAGEM_REDIGIDA)
      .select("id");
    if (erroDaGravacao) return { consumer_key, status: "error", detail: erroDaGravacao.message };
    if (!gravados || gravados.length === 0) {
      return { consumer_key, status: "skipped", detail: "message_redacted" };
    }
    // #2210 — o texto chegou. Se o turno já tiver rodado SEM ele e tiver
    // passado a conversa para humano por "não há transcrição de texto", é aqui
    // que a falha transitória deixa de ser permanente: a reação corrige o
    // motivo gravado (o banco já o desmentiu), devolve pela MESMA função do
    // botão "Devolver ao automático" e reenfileira o turno tardio.
    await reagirAConclusaoDeDerivacao(admin, {
      organizationId: msg.organization_id,
      conversationId: msg.conversation_id,
      messageId: msg.id,
      requestId: row.id,
    });
    // ─── O pedido DITO no áudio, agora que ele virou texto (#2233) ──────────
    //
    // A cascata da onda 3 sobre a transcrição — a regra de hoje e, só onde ela
    // disse não, o Jev —, que é o que faz um "não quero mais receber" falado
    // ser tratado como o escrito. Aqui e não na ingestão: o `body` do áudio
    // chegou vazio, e é o caminho que grava o bloqueio quem não o enxergava.
    //
    // Só ÁUDIO, só ENTRADA e nunca áudio do atendente (`user` /
    // `external_device`): imagem e documento derivam DESCRIÇÃO, não fala, e
    // rolar a regra sobre "o cliente mandou um comprovante" seria caçar
    // palavra em texto que ninguém disse. A mensagem redigida já ficou de fora
    // em cima: a gravação acima só escreve quando `body` não é a linha
    // anonimizada (#1991 / #2191), e é depois dela que este caminho roda.
    //
    // Nada aqui bloqueia, passa, cala ou responde — só o aviso na Central
    // (ver `./media-derive-worker.pedidos.ts`), e uma falha vira log: o áudio
    // já virou texto, que era o que a derivação existia para conseguir.
    if (
      msg.type === "audio" &&
      msg.direction === "inbound" &&
      !ENVIADO_POR_PESSOA.has(msg.sent_via ?? "") &&
      text.trim() !== ""
    ) {
      await avaliarPedidosFalados(admin, {
        organizationId: msg.organization_id,
        messageId: msg.id,
        conversationId: msg.conversation_id,
        transcricao: text,
        recebidaEm: msg.created_at ?? null,
      });
    }
    return { consumer_key, status: "ok" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (row.attempts >= DRAIN_MAX_ATTEMPTS - 1) {
      logger.error("[media-derive] failed permanently", { message_id: msg.id, detail });
      await markFailed(
        `a derivação da ${rotuloDoTipo} falhou em todas as tentativas: ${detail.slice(0, 200)}`,
      );
      // ─── E AVISA. Desistir calado era o desfecho mais comum ────────────────
      //
      // As recusas que este worker já sabia explicar — modelo sem visão,
      // provedor indisponível, falta de chave da OpenAI para transcrever —
      // abrem `midia_nao_lida` lá embaixo, e por isso pareciam cobrir o
      // assunto. Não cobriam: o que estoura como EXCEÇÃO (credencial recusada,
      // modelo que a conta não pode usar, tempo esgotado, e também o download
      // do Storage que falhou) cai aqui, marcava `failed` e não dizia nada.
      //
      // Medido numa VPS em produção (org real, 14/09): quatro imagens JPEG com
      // `media_derived_status='failed'`, os quatro eventos mortos em
      // `event_log` com "The model `claude-sonnet-5` does not exist or you do
      // not have access to it" — e a Central com ZERO avisos de mídia.
      //
      // O QUE A CENTRAL MOSTRA NESTA TENTATIVA: dois avisos, não um. Este
      // handler devolve `error` na tentativa em que `drainEventLog` desiste
      // (`row.attempts + 1 >= 5`, o mesmo limiar de `DRAIN_MAX_ATTEMPTS`), e o
      // dreno abre `event_dead` para o evento morto. Cada um só abre se não
      // houver outro da mesma família aberto na organização — então, numa pane,
      // são no máximo um de cada. O `event_dead` diz que um processamento
      // parou; este diz o que fazer (a orientação da política aponta
      // Provedores de IA).
      //
      // O marcador de "não consegui interpretar" agora É gravado por
      // `markFailed` — a consequência é a mesma das recusas dali em diante. O
      // que continua valendo é o turno que já correu: ele seguiu sem o texto,
      // dentro do teto de espera do dreno do agent-engine, e por isso a frase
      // fala do PRÓXIMO turno, não do que passou.
      //
      // O `detail` entra porque é a frase do PROVEDOR, e é ela que distingue
      // "chave errada" de "modelo que sua conta não assina" — duas ações
      // diferentes para quem opera. Mas entra no FIM, como detalhe técnico:
      // é inglês de API, e quem lê a Central não programa.
      await avisarMidiaNaoLida(
        msg.organization_id,
        rotuloDoTipo,
        "a leitura deu erro em todas as tentativas, ao abrir o arquivo ou ao chamar o provedor de IA",
        "O conteúdo do arquivo não chegou ao agente. Da próxima mensagem em diante ele sabe que houve um arquivo que não deu para ler, e responde avisando em vez de supor o que estava nele.",
        detail.slice(0, 200),
      );
    }
    return { consumer_key, status: "error", detail };
  }
}

/**
 * Lê o binding de um ponto. Fora do `gateway-binding.ts` de propósito: aquele
 * módulo devolve um `LanguageModel` pronto do SDK, e aqui o que se precisa é do
 * par provider/modelo/credencial para alimentar `resolveOrgLlmConfig`, que é
 * quem sabe decifrar a chave BYOK desta organização.
 */
async function lerBindingDoPonto(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  purpose: string,
): Promise<{
  provider: string;
  model_id: string;
  credential_id: string | null;
  base_url: string | null;
} | null> {
  const { data, error } = await admin
    .from("ai_purpose_bindings")
    .select("provider, model_id, credential_id, base_url")
    .eq("organization_id", organizationId)
    .eq("purpose", purpose)
    .eq("is_enabled", true)
    .maybeSingle();
  if (error) {
    logger.warn("[media-derive] não consegui ler o binding do ponto", {
      organization_id: organizationId,
      purpose,
      error: error.message,
    });
    return null;
  }
  return (
    (data as {
      provider: string;
      model_id: string;
      credential_id: string | null;
      base_url: string | null;
    } | null) ?? null
  );
}

function buildDeriveDeps(
  llm: { provider: string; apiKey: string; defaultModel: string | null },
  decisao: DecisaoDeTranscricao,
  orgId: string,
  admin: ReturnType<typeof createAdminClient>,
  // Endpoint próprio do binding de visão, quando houver. `null` = usa o padrão
  // do provedor, que é o comportamento do turno do agente sem `baseUrl`.
  baseUrlDaVisao: string | null = null,
  chaveEhDaInstalacao = false,
): DeriveDeps {
  const registry = createDefaultRegistry();
  // Thunk, não consulta: nada vai ao banco até a visão ser de fato perguntada,
  // e num provedor direto `visaoEmVigor` nem pergunta.
  //
  // ⚠️ Por que a consulta é escrita aqui, e também em `media-parts.ts`, em vez de
  // morar num helper compartilhado: casar o client do Supabase contra a interface
  // estreita de um helper faz o checador estourar em TS2589 ("type instantiation
  // is excessively deep") — é o parser de colunas do PostgREST, não uma
  // incompatibilidade real. E ele estoura de forma DESIGUAL: `tsc --noEmit`
  // passava e o `next build` reprovava, no mesmo arquivo e na mesma linha, o que
  // torna o helper uma armadilha que só aparece no CI. O que precisava ser único
  // é a REGRA, e ela é: `visaoEmVigor` decide, aqui e em `media-parts.ts`.
  const catalogo = async (): Promise<boolean | null> => {
    const { data } = await admin
      .from("ai_models")
      .select("supports_vision")
      .eq("provider", llm.provider)
      .eq("model_id", llm.defaultModel ?? "")
      .is("deprecated_at", null)
      .maybeSingle();
    return data?.supports_vision ?? null;
  };
  const describeImage: DeriveDeps["describeImage"] = async (buffer, mime) => {
    // ⚠️ A resposta é resolvida AQUI, não na montagem das deps, porque num
    // roteador ela depende do catálogo e a consulta é assíncrona. Antes disto
    // a pergunta ia direto ao registro, que num roteador responde pelo prefixo
    // do fabricante: `openai/gpt-3.5-turbo` era dado como capaz de ver, a
    // chamada de visão saía e o aviso ao operador nunca abria.
    const visao = await visaoEmVigor({
      provider: llm.provider,
      modelId: llm.defaultModel ?? "",
      catalogo,
    });
    const visionCapable = visao.enxerga;
    // ─── Falha VISÍVEL, não string vazia ────────────────────────────────────
    //
    // Antes daqui, modelo sem visão devolvia "" e pronto: o cliente mandava a
    // foto do produto ou o comprovante, o agente respondia como se nada tivesse
    // chegado, e não havia erro, log nem aviso em lugar nenhum. Para quem
    // instalou, o produto parecia estar ignorando o cliente de propósito.
    //
    // Agora o texto derivado DIZ que a mídia não pôde ser lida — o agente passa
    // a saber que recebeu algo que não consegue interpretar, em vez de achar
    // que a mensagem veio vazia — e um aviso abre na Central para o operador
    // poder agir (invariante 7 da doutrina do Sistema Vivo: todo laço se fecha).
    if (!visionCapable) {
      // "não sei" e "não consegue" são estados diferentes, e o aviso precisa
      // dizer qual é. Um modelo que este registro não conhece cai em
      // `{image:false}` por conservadorismo — afirmar ao operador que ele "não
      // enxerga imagens" seria gravar uma alegação que ninguém verificou (e
      // era o que acontecia com todo modelo da OpenRouter).
      const motivo = visao.sabemos
        ? `o modelo ${llm.defaultModel ?? "configurado"} não enxerga imagens`
        : `não sei se o modelo ${llm.defaultModel ?? "configurado"} enxerga imagens, ` +
          `então não arrisquei enviar a foto — escolha um modelo do catálogo em Agente de IA → Provedores`;
      await avisarMidiaNaoLida(orgId, "imagem", motivo);
      return MARCADOR_NAO_LIDA;
    }
    // O endereço é escolhido por quem administra a instalação (o campo de
    // endereço do binding) e a chamada leva a chave do provedor no cabeçalho:
    // sem esta recusa, um destino interno — o metadata da nuvem, o Postgres do
    // compose — recebe credencial da instalação e ainda pode devolver resposta
    // forjada ao agente. Mesma recusa das saídas de webhook, e antes de a
    // chave sair daqui.
    // Endereço escolhido pela organização + chave da instalação: a recusa vem
    // ANTES da checagem de destino, porque aqui nem o endereço mais público do
    // mundo torna a saída aceitável — o que está errado é de quem é a chave.
    if (baseUrlDaVisao && chaveEhDaInstalacao) {
      await avisarMidiaNaoLida(
        orgId,
        "imagem",
        "o endereço de IA configurado para esta empresa só é usado com a credencial dela: cadastre a chave da empresa em Agente de IA e Provedores, ou tire o endereço próprio para voltar ao provedor padrão da instalação",
      );
      return MARCADOR_NAO_LIDA;
    }
    if (baseUrlDaVisao) {
      const recusa = await motivoDaRecusaDeDestino(baseUrlDaVisao, "organizacao");
      if (recusa) {
        await avisarMidiaNaoLida(
          orgId,
          "imagem",
          "o endereço configurado para a visão não foi aceito como destino, então não enviei a imagem nem a chave para lá — confira o endereço do provedor em Agente de IA e Provedores; endereço escolhido pela empresa não pode apontar para a rede interna do servidor",
          undefined,
          recusa,
        );
        return MARCADOR_NAO_LIDA;
      }
    }
    const factory = registry[llm.provider];
    if (!factory) {
      await avisarMidiaNaoLida(orgId, "imagem", `o provedor ${llm.provider} não está disponível nesta instalação`);
      return MARCADOR_NAO_LIDA;
    }
    const res = await generateText({
      model: factory(llm.apiKey, llm.defaultModel ?? "", baseUrlDaVisao ?? undefined),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Descreva objetivamente esta imagem em 1-2 frases, em português, para um atendente de vendas entender o que o cliente enviou." },
            // AI SDK v7: file part com mediaType (o antigo image part é deprecated).
            { type: "file", data: buffer, mediaType: mime.split(";")[0]! },
          ],
        },
      ],
    });
    return res.text;
  };
  // Sem chave OpenAI não há como transcrever: devolver string vazia é honesto
  // (o derivado fica vazio e o marcador "[áudio]" continua valendo) e evita o
  // loop de 401 que retentava a cada drain.
  const semTranscricao: DeriveDeps["transcriber"] = {
    transcribe: async () => {
      // Mesma razão da visão: devolver "" fazia o agente responder ao áudio
      // como se ele não existisse. O aviso é o que dá ao operador a chance
      // de cadastrar a chave — sem ele, o sintoma é indistinguível de "o
      // agente é ruim".
      await avisarMidiaNaoLida(orgId, "áudio", "falta uma chave da OpenAI para transcrever");
      return MARCADOR_NAO_LIDA;
    },
  };
  // O endereço do serviço de transcrição vem do .env da instalação e a chamada
  // leva a chave no cabeçalho: mesma recusa do endereço da visão, e antes de a
  // chave sair daqui.
  const transcriberDeServico = (
    servico: NonNullable<DeriveDeps["transcriber"]>,
  ): DeriveDeps["transcriber"] => ({
    transcribe: async (audio, mime) => {
      const enderecoDoServico = env.TRANSCRIPTION_BASE_URL;
      const recusa = enderecoDoServico
        ? await motivoDaRecusaDeDestino(enderecoDoServico, "instalacao")
        : null;
      if (recusa) {
        await avisarMidiaNaoLida(
          orgId,
          "áudio",
          "o endereço configurado para a transcrição não foi aceito como destino, então não enviei o áudio nem a chave para lá — confira TRANSCRIPTION_BASE_URL; se o serviço roda na rede interna, quem administra a instalação libera o endereço em Administração › Destinos internos",
          undefined,
          recusa,
        );
        return MARCADOR_NAO_LIDA;
      }
      return servico.transcribe(audio, mime);
    },
  });
  // As três chaves da transcrição vêm do `env` — a MESMA régua do app
  // (`lib/env.ts`), não do `process.env` cru: o schema é quem dá o default e
  // quem recusa valor malformado, e uma leitura paralela aqui divergiria no dia
  // em que a régua mudasse — sem ninguém ver, porque este arquivo roda no
  // worker, não no Next. Não é dependência nova: o worker já carrega o módulo
  // por `lib/supabase/admin`.
  // ─── O degrau que a ESCADA escolheu, com a recusa onde ela vale ──────────
  //
  // Só o degrau 1 (o serviço de transcrição do `.env`) aponta para um
  // endereço configurado à mão — por isso é o único que ainda passa pela
  // recusa de destino interno antes da chave sair. Os degraus 2 e 3 vão para
  // o endereço público do provedor com a chave da própria organização.
  // `semTranscricao` continua sendo o fallback de quem não é áudio (vídeo e
  // imagem têm o caminho deles), porque o degrau 4 `nada` já foi tratado no
  // corpo do handler — lá em cima, com `failed` + motivo.
  const transcriber: DeriveDeps["transcriber"] = !decisao.transcriber
    ? semTranscricao
    : decisao.origem === "servico_da_instalacao"
      ? transcriberDeServico(decisao.transcriber)
      : decisao.transcriber;
  return {
    transcriber,
    describeImage,
    extractPdf: extractPdfText,
    // Onda 3.1: vídeo → ffmpeg (áudio+frames) reusando transcrição e visão da org.
    deriveVideo: (buffer) => deriveVideoText(buffer, { transcriber, describeImage }),
  };
}

// Mora em lib/messaging/media/derivable.ts (sem import nenhum) porque o balão
// da inbox também precisa dele para não exibir o aviso como transcrição.
export { MARCADOR_NAO_LIDA };

/**
 * Abre UM aviso na Central por organização enquanto o problema durar.
 *
 * Um aviso por mensagem inundaria a Central numa operação com volume — e
 * Central inundada é Central que ninguém abre, que é como o alerta morre. A
 * condição de não-duplicar é a mesma que `budget_exceeded` já usa: enquanto
 * houver item aberto do mesmo kind, recusas novas não criam outro.
 *
 * Fire-and-forget: falhar ao avisar não pode derrubar a derivação da mídia.
 */
/**
 * O título e o corpo do aviso `midia_nao_lida`. Primeiro o que houve e o que
 * fazer, em português; a frase crua do provedor, quando existe, no fim e
 * rotulada (`DETALHE_TECNICO`) — mesma regra do aviso de evento morto.
 */
export function textoDoAvisoDeMidiaNaoLida(aviso: {
  tipo: string;
  motivo: string;
  consequencia: string;
  detalheTecnico?: string;
}): { title: string; body: string } {
  return {
    title: `O agente não conseguiu ler ${aviso.tipo} que o cliente enviou`,
    body:
      `Motivo: ${aviso.motivo}. ${aviso.consequencia} ` +
      `Para resolver, ajuste o modelo desse ponto em Agente de IA → Provedores, ou cadastre a chave necessária em Credenciais.` +
      (aviso.detalheTecnico ? ` ${DETALHE_TECNICO} ${aviso.detalheTecnico}` : ""),
  };
}

async function avisarMidiaNaoLida(
  organizationId: string,
  tipo: string,
  motivo: string,
  /**
   * O que aconteceu com o atendimento. O padrão vale para as recusas, que
   * entregam o marcador ao agente; a falha permanente não entrega nada.
   */
  consequencia = "Enquanto isso, o agente responde avisando que não conseguiu abrir o arquivo.",
  /** A frase crua do provedor ou do armazenamento, quando houver — vai no fim, rotulada. */
  detalheTecnico?: string,
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: jaAberto } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("kind", "midia_nao_lida")
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (jaAberto) return;

    // `warn`, não `warning`: o CHECK de `agent_inbox_items.severity` aceita
    // info|warn|critical. Com o valor errado o INSERT era recusado com 23514 —
    // e o aviso NUNCA abria. A Central ficava vazia exatamente no caso que esta
    // função existe para tornar visível.
    const { error } = await admin.from("agent_inbox_items").insert({
      organization_id: organizationId,
      kind: "midia_nao_lida",
      severity: "warn",
      ...textoDoAvisoDeMidiaNaoLida({ tipo, motivo, consequencia, detalheTecnico }),
    });
    // E o retorno é CONFERIDO. O supabase-js devolve `{ error }` em vez de
    // lançar, então o `catch` abaixo era inalcançável para erro de banco: a
    // recusa era engolida, o worker devolvia "ok" e nada era logado. Um aviso
    // que falha em silêncio é pior que aviso nenhum — ele faz o próximo
    // diagnóstico começar da premissa errada.
    //
    // `23505` é a EXCEÇÃO, e não é recusa: é o índice único parcial da 0527
    // fazendo o trabalho dele. O `select` acima é uma pergunta sem trava, então
    // dois workers derivando mídia no mesmo instante podem os dois ler "não
    // existe"; quem chega segundo ao índice perde a corrida, e isso quer dizer
    // exatamente o que o aviso quer — já existe um aberto. Logar isso como aviso
    // de banco seria alarme falso em cima de um alarme correto.
    if (error && error.code !== "23505") {
      logger.warn("[media-derive] o banco recusou o aviso de mídia não lida", {
        organization_id: organizationId,
        error: error.message,
      });
    }
  } catch (err) {
    logger.warn("[media-derive] não consegui abrir o aviso de mídia não lida", {
      organization_id: organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
