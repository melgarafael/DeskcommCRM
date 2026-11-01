/**
 * A CONTA DE UMA EMPRESA — onde o par de tokens do Codex mora, quem lê e quem
 * renova. Substitui a gravação por INSTALAÇÃO em `platform_config`
 * (`OPENAI_CODEX_TOKENS`), que deixou de existir pela decisão do mantenedor
 * (PR #1672): **uma conta ChatGPT por empresa**.
 *
 * ─── Onde a conta fica ─────────────────────────────────────────────────────
 *
 * Na MESMA tabela das chaves de API, `ai_provider_credentials`, com
 * `organization_id not null` e o segredo em AES-GCM nas colunas
 * `api_key_encrypted`/`api_key_iv`/`api_key_tag` (mesmíssimo `guardar.ts`).
 * Escrita pela RLS que só deixa o `admin` da empresa gravar; leitura da tela
 * pela view `ai_provider_credentials_safe`. Sem schema novo: o `provider` é
 * vocabulário aberto desde a migration 0127.
 *
 * O plaintext guardado é `JSON.stringify(tokens)` — o MESMO formato que a
 * gravação antiga escrevia em `platform_config`, agora cifrado na tabela da
 * empresa. Nenhum leitor genérico decifra isto como chave: `loadCredential`
 * (`lib/ai/credentials.ts`) e o caminho por `credentialId` de
 * `resolveOrgLlmConfig` recusam o provider `openai-assinatura` de propósito.
 *
 * ─── MÓDULO DESLIGADO = ESTE ARQUIVO NÃO DEVOLVE NADA ──────────────────────
 *
 * O interruptor continua sendo o da INSTALAÇÃO (`login_codex` em
 * `platform_config`). Com ele desligado as linhas FICAM no banco (são da
 * empresa, cifradas e protegidas por RLS), mas todos os leitores delas as
 * ignoram: `lerLoginCodex` e `guardarLoginCodex` consultam `moduloLigado` e
 * falham fechado, e os leitores genéricos nem chegam aqui — eles recusam o
 * provider. Nada decifra o JSON dos tokens e o manda como chave de API.
 */
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";
import { guardarCredencialDoLogin, rotacionarCredencial } from "@/lib/ai/credenciais/guardar";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { PROVEDOR_POR_ASSINATURA } from "@/lib/ai/pontos/provedores";
import {
  detalheDaRecusaDeRenovacao,
  precisaRenovar,
  proximaRenovacaoEm,
  renovarSeProxima,
} from "@/lib/ai/pontos/renovacao-da-assinatura";
import { logger } from "@/lib/logger";
import { fecharAvisoDaAssinatura } from "@/lib/ai/credenciais/aviso-da-assinatura";
import { renovarPorRefreshToken, type TokensDoCodex } from "@/lib/ai/pontos/pkce-da-assinatura";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** O rótulo da linha — fixo, porque é uma por empresa. */
export const ROTULO_DO_LOGIN_CODEX = "Assinatura do ChatGPT";

/**
 * A janela da trava de renovação no BANCO. Quem vence o `UPDATE` condicional
 * segura a renovação por este tempo; quem chega dentro dele perde (`em_curso`).
 * 30 s é ordem de grandeza de UMA troca de refresh_token, contra 8 dias de
 * janela de renovação — perder aqui custa uma espera, ganhar duas vezes custa a
 * sessão da empresa (refresh_token rotativo: o segundo POST chega com um token
 * que o primeiro acabou de trocar).
 */
export const JANELA_DA_TRAVA_MS = 30_000;

/** Uma linha de login desta empresa, ou `null`. */
async function linhaDoLogin(admin: Admin, orgId: string): Promise<{ id: string } | null> {
  const { data } = await admin
    .from("ai_provider_credentials")
    .select("id")
    .eq("organization_id", orgId)
    .eq("provider", PROVEDOR_POR_ASSINATURA)
    .eq("is_active", true)
    .maybeSingle();
  return (data as { id: string } | null) ?? null;
}

export type ResultadoDeGuardarLogin =
  | { ok: true; id: string }
  /** `modulo_desligado` = o interruptor da instalação está fora. */
  | { ok: false; motivo: "cifragem" | "label_em_uso" | "banco" | "modulo_desligado" };

/**
 * GRAVA o par de tokens da empresa — insert novo, ou a MESMA linha quando ela
 * já existe (conectar de novo não pode deixar uma segunda linha atrás).
 *
 * `validated_at` nasce preenchido porque quem prova o login é a troca do
 * código (`trocarCodigoPorTokens`) — é a prova exigida por `loadCredential`,
 * que recusa credencial sem `validated_at` com `not_validated`.
 */
export async function guardarLoginCodex(p: {
  admin: Admin;
  orgId: string;
  userId: string;
  tokens: TokensDoCodex;
  requestId?: string;
}): Promise<ResultadoDeGuardarLogin> {
  if (!(await moduloLigado(p.admin, "login_codex"))) {
    return { ok: false, motivo: "modulo_desligado" };
  }
  const segredo = JSON.stringify(p.tokens);
  // O `provider` entra DENTRO do literal do argumento, e não numa variável
  // intermediária: sem contexto, o TypeScript alargaria o literal para `string`
  // e a chamada perderia o tipo da união de provedores com chave.
  const comum = {
    admin: p.admin,
    orgId: p.orgId,
    userId: p.userId,
    label: ROTULO_DO_LOGIN_CODEX,
    apiKey: segredo,
    ...(p.requestId ? { requestId: p.requestId } : {}),
  };

  const existente = await linhaDoLogin(p.admin, p.orgId);
  const r = existente
    ? await rotacionarCredencial({
        ...comum,
        provider: PROVEDOR_POR_ASSINATURA,
        credentialId: existente.id,
      })
    : await guardarCredencialDoLogin(comum);

  if (r.ok) return { ok: true, id: r.id };
  if (r.motivo === "cifragem" || r.motivo === "label_em_uso") return { ok: false, motivo: r.motivo };
  return { ok: false, motivo: "banco" };
}

/**
 * LÊ o par de tokens da empresa, decifrado. `null` quando o módulo está
 * desligado, quando não há linha, quando o envelope não abre ou quando o JSON
 * não é o formato gravado — nunca lança: quem chama é caminho de chamada, e
 * falha aqui vira queda, não 500.
 */
export async function lerLoginCodex(p: {
  admin: Admin;
  orgId: string;
}): Promise<TokensDoCodex | null> {
  try {
    if (!(await moduloLigado(p.admin, "login_codex"))) return null;
    const { data } = await p.admin
      .from("ai_provider_credentials")
      .select("api_key_encrypted, api_key_iv, api_key_tag, validated_at, is_active")
      .eq("organization_id", p.orgId)
      .eq("provider", PROVEDOR_POR_ASSINATURA)
      .eq("is_active", true)
      .maybeSingle();
    if (!data?.validated_at) return null;
    const bruto = decryptKey({
      ciphertext: byteaToBuffer(data.api_key_encrypted),
      iv: byteaToBuffer(data.api_key_iv),
      tag: byteaToBuffer(data.api_key_tag),
    });
    const json = JSON.parse(bruto) as Partial<TokensDoCodex>;
    if (
      typeof json.access_token !== "string" ||
      typeof json.refresh_token !== "string" ||
      typeof json.client_id !== "string" ||
      !Array.isArray(json.scopes) ||
      !json.scopes.includes("chatgpt.tokens.use.direct")
    ) return null;
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      client_id: json.client_id,
      ...(typeof json.id_token === "string" ? { id_token: json.id_token } : {}),
      ...(typeof json.subject === "string" ? { subject: json.subject } : {}),
      ...(typeof json.email === "string" ? { email: json.email } : {}),
      scopes: json.scopes,
      ...(typeof json.ext_agent_host_id === "string" ? { ext_agent_host_id: json.ext_agent_host_id } : {}),
      ...(typeof json.token_type === "string" ? { token_type: json.token_type } : {}),
      expires_at: typeof json.expires_at === "number" ? json.expires_at : null,
      // O marco da última rotação (#3371, fatia 5). Vem do JSON gravado, e sem
      // ele a decisão de renovar volta à régua de 8 dias — uma vez só.
      ...(typeof json.proxima_renovacao_em === "number"
        ? { proxima_renovacao_em: json.proxima_renovacao_em }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * DESCONECTA: apaga a linha da empresa. Com o módulo desligado também apaga —
 * desligar é a decisão de quem administra a instalação, e a conta continua
 * sendo da empresa.
 */
export async function desconectarLoginCodex(p: {
  admin: Admin;
  orgId: string;
}): Promise<boolean> {
  const { error } = await p.admin
    .from("ai_provider_credentials")
    .delete()
    .eq("organization_id", p.orgId)
    .eq("provider", PROVEDOR_POR_ASSINATURA);
  return !error;
}

export type ResultadoDaRenovacao =
  | { ok: true; tokens: TokensDoCodex }
  /**
   * `em_curso` = OUTRO processo está renovando agora; `nao_encontrada`, a linha sumiu.
   *
   * `motivoDetalhe` (#3371, fatia 3) é o PORQUÊ da recusa — `refresh_token_revoked`,
   * `invalid_grant`, `token_expired`, `fetch_failed`, `timeout`, `recusado` ou
   * `desconhecido`. Antes ele não existia e ~500 tentativas em 26 h produziram um
   * único `falha` sem explicação, na tela e no log.
   */
  | {
      ok: false;
      motivo: "em_curso" | "nao_encontrada" | "falha" | "modulo_desligado";
      motivoDetalhe?: string;
    };

/**
 * A TRAVA CONTRA RENOVAÇÃO SIMULTÂNEA — NO BANCO, não em memória.
 *
 * `app`, `worker` e `scheduler` são contêineres separados: um `Map` de processo
 * não os atravessa, e com refresh_token rotativo duas renovações em processos
 * diferentes revogam a sessão da empresa. O caminho escolhido é o UPDATE
 * CONDICIONAL em `updated_at` (o mantenedor citou os dois caminhos possíveis):
 *
 *   `update … set updated_at = now() where id = X and updated_at < now() - 30s`
 *
 * O Postgres serializa os dois UPDATEs na mesma linha e o segundo re-avalia a
 * condição contra a linha JÁ mudada — só um processo vence. Nada de coluna nova
 * e nada de transaction aberta durante a chamada à OpenAI.
 *
 * Quem perde devolve `em_curso` SEM chamar o provedor: o renova de novo seria
 * mandar um refresh_token que o vencedor acabou de trocar.
 */
export async function renovarComTravaDeBanco(p: {
  admin: Admin;
  orgId: string;
  credentialId: string;
  /** Quem pediu (o botão de revalidar). `null` = renovação automática, sem usuário. */
  userId: string | null;
  renovar: (tokensAtuais: TokensDoCodex) => Promise<TokensDoCodex>;
}): Promise<ResultadoDaRenovacao> {
  if (!(await moduloLigado(p.admin, "login_codex"))) return { ok: false, motivo: "modulo_desligado" };

  const { data: atual } = await p.admin
    .from("ai_provider_credentials")
    .select("api_key_encrypted, api_key_iv, api_key_tag, validated_at, updated_at")
    .eq("id", p.credentialId)
    .eq("organization_id", p.orgId)
    .eq("provider", PROVEDOR_POR_ASSINATURA)
    .maybeSingle();
  if (!atual) return { ok: false, motivo: "nao_encontrada" };

  const atualizadoEm = typeof atual.updated_at === "string" ? atual.updated_at : null;
  const limite = new Date(Date.now() - JANELA_DA_TRAVA_MS).toISOString();

  // A APROPRIAÇÃO: só vence quem encontra a linha com `updated_at` antigo.
  const { data: ganha } = await p.admin
    .from("ai_provider_credentials")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", p.credentialId)
    .eq("organization_id", p.orgId)
    .lt("updated_at", limite)
    .select("id")
    .maybeSingle();
  if (!ganha) return { ok: false, motivo: "em_curso" };

  let renovados: TokensDoCodex;
  try {
    const atuais = decryptKey({
      ciphertext: byteaToBuffer(atual.api_key_encrypted),
      iv: byteaToBuffer(atual.api_key_iv),
      tag: byteaToBuffer(atual.api_key_tag),
    });
    const json = JSON.parse(atuais) as Partial<TokensDoCodex>;
    if (typeof json.refresh_token !== "string" || typeof json.client_id !== "string") {
      return { ok: false, motivo: "falha" };
    }
    renovados = await p.renovar({
      access_token: json.access_token ?? "",
      refresh_token: json.refresh_token,
      client_id: json.client_id,
      ...(typeof json.id_token === "string" ? { id_token: json.id_token } : {}),
      ...(typeof json.subject === "string" ? { subject: json.subject } : {}),
      ...(typeof json.email === "string" ? { email: json.email } : {}),
      ...(Array.isArray(json.scopes) ? { scopes: json.scopes } : {}),
      ...(typeof json.ext_agent_host_id === "string" ? { ext_agent_host_id: json.ext_agent_host_id } : {}),
      ...(typeof json.token_type === "string" ? { token_type: json.token_type } : {}),
      expires_at: typeof json.expires_at === "number" ? json.expires_at : null,
    });
    renovados = {
      ...renovados,
      client_id: renovados.client_id ?? json.client_id,
      ...(renovados.id_token ? {} : typeof json.id_token === "string" ? { id_token: json.id_token } : {}),
      ...(renovados.subject ? {} : typeof json.subject === "string" ? { subject: json.subject } : {}),
      ...(renovados.email ? {} : typeof json.email === "string" ? { email: json.email } : {}),
      scopes: renovados.scopes ?? (Array.isArray(json.scopes) ? json.scopes : []),
      ...(renovados.ext_agent_host_id
        ? {}
        : typeof json.ext_agent_host_id === "string"
          ? { ext_agent_host_id: json.ext_agent_host_id }
          : {}),
      token_type: renovados.token_type ?? (typeof json.token_type === "string" ? json.token_type : "Bearer"),
    };
    // O `expires_at` do token NOVO e o marco que fecha a janela desta rotação
    // (#3371, fatia 5). É o que impede o turno seguinte de rotacionar outra vez
    // com o par que este POST acabou de receber — e o que faz a condição de
    // necessidade olhar o token novo, não o que foi lido antes da trava.
    renovados = {
      ...renovados,
      proxima_renovacao_em: proximaRenovacaoEm(renovados.expires_at),
    };
  } catch (erro) {
    // A renovação falhou — e o MOTIVO fica registrado (#3371, fatia 3).
    //
    // Antes este `catch` era mudo e devolvia `falha` para tudo: refresh
    // revogado, `invalid_grant`, DNS fora do ar e timeout ficavam idênticos. No
    // incidente do cliente Obralivre a renovação tentou ~500 vezes em ~26 h e
    // não sobrou UMA linha dizendo por quê — a tela mostrava `validation_error`
    // vazio e o log, nada.
    const motivoDetalhe = detalheDaRecusaDeRenovacao(erro);
    // Devolve o relógio de aprovação ao valor lido, para que a próxima
    // tentativa não espere 30 s por uma trava que ninguém segura — e grava o
    // motivo no MESMO update, porque `validation_error` é o campo que a tela de
    // Credenciais mostra a quem vai reconectar a conta.
    await p.admin
      .from("ai_provider_credentials")
      .update({
        ...(atualizadoEm ? { updated_at: atualizadoEm } : {}),
        validation_error: `renovacao_recusada:${motivoDetalhe}`,
      })
      .eq("id", p.credentialId)
      .eq("organization_id", p.orgId);
    // Só o rótulo: a mensagem do provedor pode carregar o refresh_token
    // recusado, e log não é lugar de segredo. Nada de access_token, nada de
    // cabeçalho de autorização.
    logger.warn("[assinatura] renovação recusada — o motivo fica registrado", {
      organization_id: p.orgId,
      credential_id: p.credentialId,
      motivo: motivoDetalhe,
    });
    return { ok: false, motivo: "falha", motivoDetalhe };
  }

  const gravado = await rotacionarCredencial({
    admin: p.admin,
    orgId: p.orgId,
    userId: p.userId,
    credentialId: p.credentialId,
    provider: PROVEDOR_POR_ASSINATURA,
    apiKey: JSON.stringify(renovados),
    label: ROTULO_DO_LOGIN_CODEX,
    manterModelos: true,
  });
  if (!gravado.ok) {
    // A troca com o provedor deu certo e a gravação não: o motivo tem nome
    // próprio, senão este caso (credencial que não aceita o par novo) ficaria
    // indistinguível de "a OpenAI recusou o token".
    return { ok: false, motivo: "falha", motivoDetalhe: "credential_nao_gravada" };
  }

  // O login voltou: o aviso único da Central fecha aqui (#3371, fatia 2). É o
  // ponto por onde passam o botão de revalidar, a renovação automática e a do
  // turno — sem isto, um timeout passageiro deixava o aviso aberto para sempre
  // depois que a renovação seguinte deu certo. Best-effort: a rotação já gravou.
  await fecharAvisoDaAssinatura(p.admin, p.orgId).catch(() => "falhou");

  return { ok: true, tokens: renovados };
}

/**
 * RENOVA AGORA, PORQUE O PROVEDOR ACABOU DE RECUSAR O TOKEN (#3371, fatia 4).
 *
 * É o caminho do 401 DENTRO do turno: o `401 · Provided authentication token is
 * expired` que o cliente Obralivre recebeu em 107 turnos seguidos. A renovação
 * proativa (`lerLoginCodexRenovandoSeProxima`, acima) só olha a janela de
 * vencimento — quando o token venceu por outro motivo, ou quando a janela passou
 * sem ninguém chamar, ela não tem o que fazer, e a chamada caía na política de
 * reserva sem NUNCA tentar renovar.
 *
 * Usa a MESMA trava de banco da renovação automática e do botão de revalidar:
 * um POST por janela, em qualquer processo. `userId: null` porque quem pediu foi
 * o turno, não uma pessoa — a auditoria não inventa autor.
 */
export async function renovarAssinaturaNoTurno(p: {
  admin: Admin;
  orgId: string;
}): Promise<ResultadoDaRenovacao> {
  const linha = await linhaDoLogin(p.admin, p.orgId);
  if (linha === null) return { ok: false, motivo: "nao_encontrada" };
  return renovarComTravaDeBanco({
    admin: p.admin,
    orgId: p.orgId,
    credentialId: linha.id,
    userId: null,
    renovar: (atuais) => {
      if (!atuais.client_id) throw new Error("credencial_siwc_sem_client_id");
      return renovarPorRefreshToken({
        refreshToken: atuais.refresh_token,
        clientId: atuais.client_id,
      });
    },
  });
}

/**
 * LÊ o par da empresa e, quando a janela de renovação abriu, RENOVA antes de
 * devolver — é este que o caminho do agente chama (#1639, parte 2).
 *
 * Duas decisões aqui, e só duas:
 *
 *  1. **`userId: null`.** Ninguém pediu esta renovação: é o relógio batendo na
 *     janela de 8 dias, dentro de uma chamada de conversa. A auditoria grava
 *     `null` de propósito, e não um usuário qualquer — quem nunca pediu nada não
 *     pode aparecer como quem pediu. O caminho MANUAL (botão "revalidar" em
 *     `revalidate/route.ts`) continua levando o `userId` de quem clicou.
 *  2. **Falha de renovação não derruba a leitura.** O token atual ainda pode
 *     valer; se estiver vencido, a chamada cai na reserva pela política que já
 *     existe (`decidirQuedaDoProvedor`). Derrubar o turno aqui seria trocar um
 *     problema de manutenção por um cliente sem resposta.
 *
 * A trava contra renovação simultânea é a DO BANCO (`renovarComTravaDeBanco`),
 * por uma razão de topologia: `app`, `worker` e `scheduler` são contêineres
 * separados, e um `Map` de processo não os atravessa.
 */
export async function lerLoginCodexRenovandoSeProxima(p: {
  admin: Admin;
  orgId: string;
  /** Só para teste: o relógio da janela de renovação. */
  agora?: number;
}): Promise<TokensDoCodex | null> {
  const tokens = await lerLoginCodex(p);
  if (tokens === null) return null;
  // `precisaRenovar` e não `renovacaoProxima`: a janela de 8 dias é maior que a
  // vida do access_token, então a régua antiga respondia "renove" em TODO turno
  // logo depois de rotacionar (#3371, fatia 5 — ~500 POSTs em ~26 h). O marco
  // gravado na rotação é quem fecha a janela daquele par.
  if (!precisaRenovar(tokens, p.agora)) return tokens;

  const linha = await linhaDoLogin(p.admin, p.orgId);
  if (linha === null) return tokens;

  let renovados: TokensDoCodex | null = null;
  // O motivo da recusa atravessa o `throw` para chegar ao log deste nível: o
  // caminho automático não tem quem leia o retorno, e um `catch` sem motivo era
  // exatamente o silêncio do incidente (#3371, fatia 3).
  let motivoDaRecusa: string | null = null;
  try {
    await renovarSeProxima({
      expiraEm: tokens.expires_at,
      ...(p.agora === undefined ? {} : { agora: p.agora }),
      renovar: async () => {
        const r = await renovarComTravaDeBanco({
          admin: p.admin,
          orgId: p.orgId,
          credentialId: linha.id,
          userId: null,
          renovar: (atuais) => {
            if (!atuais.client_id) throw new Error("credencial_siwc_sem_client_id");
            return renovarPorRefreshToken({ refreshToken: atuais.refresh_token, clientId: atuais.client_id });
          },
        });
        if (!r.ok) {
          motivoDaRecusa = r.motivoDetalhe ? `${r.motivo}:${r.motivoDetalhe}` : r.motivo;
          throw new Error(`renovacao_automática_recusada: ${motivoDaRecusa}`);
        }
        renovados = r.tokens;
        return r.tokens;
      },
    });
  } catch (erro) {
    // Renovação recusada, em curso noutro processo ou módulo desligado no meio
    // do caminho. O token que já temos segue em uso; a queda, se for o caso,
    // acontece na política da reserva e não aqui.
    //
    // O MOTIVO vai para o log (#3371, fatia 3): este `catch` é o último ponto
    // em que a recusa ainda tem nome. `organizacao` + rótulo bastam para o
    // plantão saber se reconecta a conta (revogado) ou espera (rede).
    logger.warn("[assinatura] a renovação automática não renovou — o token atual segue em uso", {
      organization_id: p.orgId,
      motivo: motivoDaRecusa ?? detalheDaRecusaDeRenovacao(erro),
    });
  }
  return renovados ?? tokens;
}
