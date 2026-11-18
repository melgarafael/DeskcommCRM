/**
 * A conexão do número oficial por UM CLIQUE — o fluxo inteiro, do lado de dentro do seam.
 *
 * A rota (`app/api/v1/channels/partner/um-clique`) e a tela não sabem com quem
 * falam: perguntam se o clique está disponível, pedem a página e entregam a
 * volta. Quem decide é este arquivo; quem fala com o provedor é
 * `zernio/conexao-pela-instalacao.ts`; quem grava é `connect.ts`.
 *
 * ─── A ordem é a ordem em que dá errado ─────────────────────────────────────
 *
 *   1. a VAGA do plano é conferida ANTES de mandar a pessoa à Meta. Conferida
 *      só na gravação, ela terminaria o cadastro, o número ficaria conectado na
 *      conta da instalação (e na fatura dela) e o CRM recusaria no fim;
 *   2. o número que o perfil JÁ tem conclui sem passar pela Meta — é reconectar
 *      e é a volta que se perdeu no meio (o provedor aceita um WhatsApp por
 *      perfil, então mandar de novo à Meta terminaria em recusa);
 *   3. a sessão é gravada ANTES do webhook: a primeira entrega procura a sessão
 *      pela conta, e uma entrega sem sessão é descartada;
 *   4. o número entra no webhook ÚNICO da instalação (o filtro ganha o perfil
 *      da organização). Reconectar não troca a assinatura que já entrega:
 *      nenhum evento se perde na troca.
 *
 * O perfil leva a marca da INSTALAÇÃO no nome (`nomeDoPerfil`): a conta do
 * provedor pode ser compartilhada com outros sistemas do mesmo dono.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";

import { marcaDaSaida } from "@/lib/branding/saida";
import { lerLimiteDoPlano, mensagemDoLimite } from "@/lib/cobranca/limites";
import type { Idioma } from "@/lib/i18n/idiomas";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

import { CHANNEL_PROVIDER_WACALLS } from "./capabilities";
import {
  PARTNER_CHANNEL_LABEL,
  findPartnerSession,
  registrarNoWebhookDaInstalacao,
  savePartnerSession,
  segredoAtualDoWebhook,
  type PartnerSession,
} from "./connect";
import { emitirEstadoDaVolta, verificarEstadoDaVolta } from "./estado-da-volta";
import {
  ID_DO_PROVEDOR,
  contaConectadaNoPerfil,
  garantirPerfil,
  motivoDaVolta,
  urlDaPaginaDeConexao,
  whatsappDoPerfil,
  type ContaConectada,
} from "./zernio/conexao-pela-instalacao";
import { chaveDaInstalacao } from "./zernio/credentials";

/** Recusa com o que a tela mostra. `code` segue o vocabulário de `lib/api/errors`. */
export class ErroDaConexaoUmClique extends Error {
  constructor(
    message: string,
    public status = 422,
    public code = "invalid_request",
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** A instalação tem conta no provedor? É o que liga o botão na tela. */
export async function umCliqueDisponivel(): Promise<boolean> {
  return (await chaveDaInstalacao()) !== null;
}

export interface ContextoDaConexao {
  organizationId: string;
  organizationNome: string;
  userId: string;
  idioma: Idioma;
  /** `env.INTERNAL_SECRET`: assina o estado que vai e volta pela URL. */
  segredo: string;
  agora: Date;
  /** Origem pública da instalação, sem barra no fim. */
  publicBase: string;
}

export interface ConexaoConcluida {
  channelSessionId: string;
  phoneNumber: string | null;
  displayName: string;
  /** `false` quando o provedor recusou o webhook: o número envia, mas não recebe. */
  webhookRegistrado: boolean;
}

/**
 * A marca da INSTALAÇÃO para o nome do perfil e do webhook, ou `null` quando é a
 * do produto (sem marca própria, o perfil fica sem prefixo). Nunca lança.
 */
async function marcaDaInstalacaoParaOProvedor(): Promise<string | null> {
  const marca = await marcaDaSaida(null);
  return marca.origens.nome === "padrao" ? null : marca.nome;
}

async function chaveOuRecusa(): Promise<string> {
  const chave = await chaveDaInstalacao();
  if (!chave) {
    throw new ErroDaConexaoUmClique(
      "Esta instalação não tem conta no provedor para conectar com um clique. Use a sua própria chave.",
      404,
      "not_found",
    );
  }
  return chave;
}

/**
 * Cabe mais um número no plano? A mesma conta do gatilho
 * `fn_trava_canais_do_plano`: sessões não arquivadas, menos as de chamada. A
 * sessão desta conexão que já está ativa não conta como número novo.
 */
async function conferirVagaDoPlano(
  admin: SupabaseClient,
  ctx: ContextoDaConexao,
  existente: PartnerSession | null,
): Promise<void> {
  if (existente && !existente.archivedAt) return;
  const limite = await lerLimiteDoPlano(admin, ctx.organizationId, "canais");
  if (limite === null) return;
  const { count, error } = await admin
    .from("channel_sessions")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ctx.organizationId)
    .is("archived_at", null)
    .neq("provider", CHANNEL_PROVIDER_WACALLS);
  if (error) throw new Error(`vaga do plano não conferida: ${error.message}`);
  if ((count ?? 0) >= limite) {
    throw new ErroDaConexaoUmClique(
      mensagemDoLimite("canais", limite, ctx.idioma),
      409,
      "plan_limit_reached",
      {
        recurso: "canais",
        limite,
      },
    );
  }
}

/** A conexão por chave própria ativa não é sobrescrita por baixo: excluir é decisão da pessoa. */
function recusarSeHaChavePropria(existente: PartnerSession | null): void {
  if (existente && !existente.archivedAt && !existente.pelaInstalacao) {
    throw new ErroDaConexaoUmClique(
      "Este número foi conectado com a chave própria da organização. Para conectar pela instalação, exclua a conexão atual em Conexões antes.",
      409,
      "state_conflict",
    );
  }
}

async function gravarConexao(
  admin: SupabaseClient,
  ctx: ContextoDaConexao,
  chave: string,
  profileId: string,
  conta: ContaConectada,
  existente: PartnerSession | null,
): Promise<ConexaoConcluida> {
  // Token e segredo próprios continuam na linha, como em toda sessão do canal,
  // mas o provedor entrega pelo webhook da instalação: nenhum dos dois é
  // registrado em lugar nenhum.
  const token = existente?.webhookPathToken ?? randomBytes(16).toString("hex");
  const segredoAtual = existente
    ? await segredoAtualDoWebhook(admin, ctx.organizationId, existente.id)
    : null;
  const segredo = segredoAtual ?? randomBytes(32).toString("hex");
  const segredoCifrado = await encryptWebhookSecret(admin, segredo);
  if (!segredoCifrado) {
    throw new ErroDaConexaoUmClique(
      "cifra indisponível nesta instalação — a conexão não foi gravada",
    );
  }
  const displayName = existente?.displayName || conta.nome || PARTNER_CHANNEL_LABEL;
  const { error, id } = await savePartnerSession(admin, {
    organizationId: ctx.organizationId,
    existingId: existente?.id ?? null,
    accountId: conta.accountId,
    credencial: { tipo: "instalacao", profileId },
    webhookPathToken: token,
    webhookSecretEncrypted: segredoCifrado,
    phoneNumber: conta.telefone,
    displayName,
  });
  // A mensagem crua sobe: é ela que carrega o limite do plano para a rota traduzir.
  if (error || !id) throw new Error(error ?? "a sessão não foi gravada");
  const marca = await marcaDaInstalacaoParaOProvedor();
  const webhookId = await registrarNoWebhookDaInstalacao(admin, {
    organizationId: ctx.organizationId,
    sessionId: id,
    apiKey: chave,
    publicBase: ctx.publicBase,
    nome: `${marca ?? "CRM"} · um clique`,
    legado: existente?.pelaInstalacao ? existente.webhookId : null,
  });
  return {
    channelSessionId: id,
    phoneNumber: conta.telefone,
    displayName,
    webhookRegistrado: webhookId !== null,
  };
}

export type InicioDaConexao =
  { tipo: "pagina"; url: string } | ({ tipo: "concluida" } & ConexaoConcluida);

/**
 * Começa a conexão: devolve a página de cadastro do provedor — ou, quando o
 * perfil já tem o número, conclui na hora.
 */
export async function iniciarConexaoUmClique(
  admin: SupabaseClient,
  ctx: ContextoDaConexao,
  opcoes: { coexistencia: boolean; marca: string; cor: string | null },
): Promise<InicioDaConexao> {
  const chave = await chaveOuRecusa();
  const existente = await findPartnerSession(admin, ctx.organizationId);
  recusarSeHaChavePropria(existente);
  await conferirVagaDoPlano(admin, ctx, existente);
  const profileId = await garantirPerfil(chave, {
    id: ctx.organizationId,
    nome: ctx.organizationNome,
    marca: await marcaDaInstalacaoParaOProvedor(),
    perfilGravado: existente?.profileId ?? null,
  });
  const jaNoPerfil = await whatsappDoPerfil(chave, profileId);
  if (jaNoPerfil) {
    return {
      tipo: "concluida",
      ...(await gravarConexao(admin, ctx, chave, profileId, jaNoPerfil, existente)),
    };
  }
  const estado = emitirEstadoDaVolta(
    { organizationId: ctx.organizationId, userId: ctx.userId, profileId },
    { segredo: ctx.segredo, agora: ctx.agora },
  );
  const url = await urlDaPaginaDeConexao(chave, {
    profileId,
    redirectUrl: `${ctx.publicBase}/auth/partner-return/${estado}`,
    coexistencia: opcoes.coexistencia,
    marca: opcoes.marca,
    cor: opcoes.cor,
    idioma: ctx.idioma,
  });
  return { tipo: "pagina", url };
}

export interface VoltaDaConexao {
  estado: string;
  accountId?: string;
  profileId?: string;
  /** O código que o provedor acrescentou quando o cadastro não terminou. */
  erro?: string;
}

/**
 * Conclui a volta. O estado prova que o perfil é DESTA organização; o provedor
 * prova que a conta está naquele perfil. Os dois, ou nada é gravado.
 */
export async function concluirConexaoUmClique(
  admin: SupabaseClient,
  ctx: ContextoDaConexao,
  volta: VoltaDaConexao,
): Promise<ConexaoConcluida> {
  const estado = verificarEstadoDaVolta(volta.estado, { segredo: ctx.segredo, agora: ctx.agora });
  if (!estado || estado.organizationId !== ctx.organizationId) {
    throw new ErroDaConexaoUmClique(
      "Esta volta da conexão não é válida ou expirou. Conecte de novo.",
      400,
    );
  }
  if (volta.erro) throw new ErroDaConexaoUmClique(motivoDaVolta(volta.erro), 422);
  if (
    !volta.accountId ||
    !ID_DO_PROVEDOR.test(volta.accountId) ||
    volta.profileId !== estado.profileId
  ) {
    throw new ErroDaConexaoUmClique(
      "Esta volta da conexão não é válida ou expirou. Conecte de novo.",
      400,
    );
  }
  const chave = await chaveOuRecusa();
  const conta = await contaConectadaNoPerfil(chave, estado.profileId, volta.accountId);
  if (!conta) {
    throw new ErroDaConexaoUmClique(
      "O provedor não confirmou este número no perfil da organização. Conecte de novo.",
    );
  }
  const existente = await findPartnerSession(admin, ctx.organizationId);
  recusarSeHaChavePropria(existente);
  return gravarConexao(admin, ctx, chave, estado.profileId, conta, existente);
}
