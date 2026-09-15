/**
 * Registrar o webhook de uma sessão de canal oficial — o caso de uso, não a chamada.
 *
 * Fica separado de `webhook-override.ts` (que sabe FALAR com a Meta) pela mesma
 * divisão do resto do canal: aqui mora o que o CRM faz com a sessão — decifrar a
 * credencial, descobrir o verify token EM VIGOR (banco, com o `.env` de piso),
 * montar a URL e GRAVAR o desfecho; lá mora o POST na Graph API.
 *
 * ─── O desfecho é gravado, e a falha não desfaz a conexão ────────────────────
 * A conexão já funcionava sem este passo: o operador colava a URL à mão no painel
 * da Meta. Quem não colava seguia com um canal que envia e não recebe — o defeito
 * silencioso que a fatia F1 (#850) fecha. Por isso o desfecho vira COLUNA
 * (`meta_webhook_override_uri|erro|em`, migration 0256): a tela mostra "conectado,
 * webhook pendente: <motivo>" com botão de tentar de novo, em vez de dizer
 * "conectado" e deixar a descoberta para a primeira mensagem que nunca chega.
 *
 * ─── Banco sem a migration 0256 não mente nem quebra ────────────────────────
 * Aplicar migration é passo SEPARADO do deploy neste projeto. Se a coluna não
 * existir, a gravação do desfecho falha com o nome dela na mensagem e é tratada
 * como ausência de schema (log de aviso), não como erro de produto: o desfecho
 * ainda volta para a resposta da rota, que é onde o operador o vê.
 */
import { appDaMeta } from "@/lib/channels/meta/app";
import {
  registrarWebhookDoNumero,
  urlDeCallbackDaSessao,
} from "@/lib/channels/meta/webhook-override";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

/** As três colunas do desfecho, na ordem em que a migration 0256 as cria. */
export const COLUNAS_DO_DESFECHO_DO_WEBHOOK =
  "meta_webhook_override_uri, meta_webhook_override_erro, meta_webhook_override_em";

export interface DesfechoDoWebhookDaSessao {
  /** A Meta está entregando no NOSSO endereço? */
  registrado: boolean;
  /** A URL que ficou registrada (null quando não registrou). */
  url: string | null;
  /** O motivo, para a tela — null quando deu certo. */
  erro: string | null;
  /** Quando foi esta tentativa (ISO). */
  em: string;
}

/** O erro é "a migration 0256 não rodou neste banco" — e não um erro de verdade. */
function ehColunaDoDesfechoAusente(mensagem: string | null | undefined): boolean {
  return (mensagem ?? "").includes("meta_webhook_override");
}

export async function registrarWebhookDaSessao(input: {
  admin: ReturnType<typeof createAdminClient>;
  channelSessionId: string;
  phoneNumberId: string;
  wabaId: string;
  tokenCifrado: string;
  webhookPathToken: string;
  base: string;
  requestId?: string;
}): Promise<DesfechoDoWebhookDaSessao> {
  const em = new Date().toISOString();

  const gravar = async (desfecho: DesfechoDoWebhookDaSessao): Promise<void> => {
    const { error } = await input.admin
      .from("channel_sessions")
      .update({
        meta_webhook_override_uri: desfecho.url,
        meta_webhook_override_erro: desfecho.erro,
        meta_webhook_override_em: desfecho.em,
      })
      .eq("id", input.channelSessionId);

    if (!error) return;
    if (ehColunaDoDesfechoAusente(error.message)) {
      logger.warn(
        "migration 0256 não aplicada: o desfecho do webhook não foi gravado (a rota devolve o estado na resposta)",
        { requestId: input.requestId, channelSessionId: input.channelSessionId },
      );
      return;
    }
    logger.error("falha ao gravar o desfecho do webhook da sessão", {
      requestId: input.requestId,
      channelSessionId: input.channelSessionId,
      erro: error.message,
    });
  };

  const token = await decryptWebhookSecret(input.admin, input.tokenCifrado);
  if (!token) {
    // Cifra indisponível ou ciphertext ilegível: sem token não há como falar com a
    // Meta em nome desta sessão. Dizer "credencial ilegível" é diferente de "a Meta
    // recusou" — o operador troca a credencial no primeiro caso e o app no segundo.
    const desfecho: DesfechoDoWebhookDaSessao = {
      registrado: false,
      url: null,
      erro: "a credencial do canal não pôde ser decifrada nesta instalação (GUC de cifra)",
      em,
    };
    await gravar(desfecho);
    return desfecho;
  }

  const app = await appDaMeta();
  if (!app.verifyToken) {
    // O verify token é o que a Meta repete no handshake: sem ele o override até
    // registraria, e o GET de verificação responderia 403 — webhook registrado e
    // nunca aceito, que é pior que webhook não registrado.
    const desfecho: DesfechoDoWebhookDaSessao = {
      registrado: false,
      url: null,
      erro: "a instalação não tem o verify token (tela de canais oficiais ou META_WEBHOOK_VERIFY_TOKEN)",
      em,
    };
    await gravar(desfecho);
    return desfecho;
  }

  const callbackUrl = urlDeCallbackDaSessao(input.base, input.webhookPathToken);
  const resultado = await registrarWebhookDoNumero({
    phoneNumberId: input.phoneNumberId,
    wabaId: input.wabaId,
    token,
    callbackUrl,
    verifyToken: app.verifyToken,
  });

  const desfecho: DesfechoDoWebhookDaSessao = resultado.ok
    ? { registrado: true, url: resultado.url, erro: null, em }
    : {
        registrado: false,
        url: null,
        erro:
          resultado.etapa === "inscricao_na_waba"
            ? `não consegui inscrever o app na WABA (${resultado.motivo})`
            : `a Meta recusou o webhook do número (${resultado.motivo})`,
        em,
      };
  await gravar(desfecho);
  return desfecho;
}
