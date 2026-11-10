/**
 * O número oficial conectado com UM CLIQUE, pela conta do provedor DA INSTALAÇÃO.
 *
 * ─── O que o cliente da instalação não conseguia ────────────────────────────
 *
 * A conexão por credencial (`lib/channels/connect.ts`) pede a chave de API e o
 * id da conta no painel do provedor, e depois manda colar a URL e o segredo do
 * webhook lá. Quem revende a instalação tem a conta do provedor; o cliente dele
 * não tem acesso a ela, e não deveria ter: a chave alcança todos os números.
 *
 * ─── O desenho ──────────────────────────────────────────────────────────────
 *
 *   1. um PERFIL do provedor por organização (`garantirPerfil`). O provedor
 *      aceita um WhatsApp por perfil, e é o perfil que separa uma organização
 *      da outra dentro da mesma conta;
 *   2. a página de cadastro da Meta hospedada pelo próprio provedor
 *      (`urlDaPaginaDeConexao`), com o nome e a cor da marca da instalação;
 *   3. na volta, a conta só vale se estiver NAQUELE perfil
 *      (`contaConectadaNoPerfil`). É o que impede uma volta forjada de prender
 *      à organização um número que não é dela;
 *   4. os eventos chegam pelo webhook ÚNICO da instalação, filtrado aos perfis
 *      das conexões de um clique (`webhook-da-instalacao.ts`), e a rota de
 *      entrada roteia pela conta. Uma assinatura por número esgotava o teto de
 *      assinaturas do provedor em poucas dezenas de clientes.
 *
 * `garantirWebhook` (uma assinatura por número, filtrada à conta) fica para a
 * conexão por CHAVE PRÓPRIA: ali a conta do provedor é da organização.
 *
 * Tudo aqui fala só com o provedor: quem grava no banco é `connect.ts`.
 */
import { z } from "zod";

import { socialRequest as pedirAoProvedor, SocialError as ErroDoProvedor } from "../social/client";

export { ErroDoProvedor };

/**
 * Os eventos que a assinatura de cada número recebe. É a lista que o número
 * oficial em produção já usa (medido numa instalação real em 20/10/2026):
 * mensagens, desfechos, modelos, reações e o estado do número.
 */
export const EVENTOS_DO_WEBHOOK = [
  "message.received",
  "message.sent",
  "message.delivered",
  "message.read",
  "message.failed",
  "message.edited",
  "message.deleted",
  "reaction.received",
  "account.connected",
  "account.disconnected",
  "whatsapp.number.activated",
  "whatsapp.number.declined",
  "whatsapp.number.suspended",
  "whatsapp.number.reactivated",
  "whatsapp.number.released",
  "whatsapp.number.kyc_submitted",
  "whatsapp.number.verification_required",
  "whatsapp.number.action_required",
  "whatsapp.template.status_updated",
  "whatsapp.template.category_updated",
] as const;

/** Id do provedor: 24 hex. Tudo o que volta pela URL passa por aqui antes de ir a uma chamada. */
export const ID_DO_PROVEDOR = /^[a-f0-9]{24}$/;

/**
 * Nome do perfil: a marca da INSTALAÇÃO, o nome da organização e o id dela —
 * único no time (o provedor recusa nome repetido com 409) mesmo com duas
 * organizações chamadas "Loja". O id vai INTEIRO e no fim: é a parte que não
 * muda quando a organização é renomeada ou a marca troca, e é por ela que
 * `garantirPerfil` reacha o perfil (um prefixo curto poderia casar com o de
 * outra organização).
 *
 * A marca vem na frente porque a conta do provedor pode ser compartilhada com
 * outros sistemas do mesmo dono, que também criam um perfil por cliente; sem
 * ela, no painel do provedor não dá para saber de qual sistema é cada perfil.
 * Sem marca própria (`marca` nula), fica o formato sem prefixo.
 */
export function nomeDoPerfil(org: { id: string; nome: string; marca?: string | null }): string {
  const nome = org.nome.trim().replace(/\s+/g, " ").slice(0, 40) || "Organização";
  const marca = (org.marca ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
  return marca ? `${marca} · ${nome} · ${org.id}` : `${nome} · ${org.id}`;
}

const perfisSchema = z.object({
  profiles: z.array(z.object({ _id: z.string(), name: z.string() })),
});

/**
 * O perfil desta organização no provedor: o já gravado, ou um novo.
 *
 * Idempotente pelo id da organização no fim do nome: uma primeira tentativa
 * que criou o perfil e morreu antes de a tela receber a resposta faz a segunda
 * receber 409, e aí o perfil é achado na lista em vez de nascer outro. Achar
 * pelo id, e não pelo nome inteiro, é o que faz renomear a organização (ou
 * trocar a marca) reaproveitar o perfil em vez de criar outro na conta da
 * instalação a cada clique.
 */
export async function garantirPerfil(
  chave: string,
  org: { id: string; nome: string; marca?: string | null; perfilGravado: string | null },
): Promise<string> {
  const perfis = perfisSchema.parse(await pedirAoProvedor(chave, "profiles")).profiles;
  if (org.perfilGravado && perfis.some((p) => p._id === org.perfilGravado))
    return org.perfilGravado;
  const nome = nomeDoPerfil(org);
  const daOrganizacao = (p: { name: string }) => p.name.endsWith(` · ${org.id}`);
  const existente = perfis.find(daOrganizacao);
  if (existente) return existente._id;
  try {
    const criado = z
      .object({ profile: z.object({ _id: z.string() }) })
      .parse(await pedirAoProvedor(chave, "profiles", { name: nome }));
    return criado.profile._id;
  } catch (erro) {
    if (!(erro instanceof ErroDoProvedor && erro.upstreamStatus === 409)) throw erro;
    const achado = perfisSchema
      .parse(await pedirAoProvedor(chave, "profiles"))
      .profiles.find(daOrganizacao);
    if (!achado) throw erro;
    return achado._id;
  }
}

export interface PaginaDeConexao {
  profileId: string;
  /** Para onde o provedor devolve o navegador, com `connected`/`error` acrescentados. */
  redirectUrl: string;
  /** O número já está na app WhatsApp Business e continua nela (coexistência). */
  coexistencia: boolean;
  marca: string;
  /** `#RRGGBB`; outro formato fica de fora, porque o provedor recusa a chamada inteira. */
  cor: string | null;
  idioma: string;
}

/** O provedor só conhece estes três idiomas na página hospedada. */
function idiomaDaPagina(idioma: string): "es" | "pt-BR" | "en" {
  const base = idioma.toLowerCase();
  if (base.startsWith("es")) return "es";
  if (base.startsWith("pt")) return "pt-BR";
  return "en";
}

/**
 * O navegador da pessoa vai para este endereço: só https. A exceção é a própria
 * máquina (`localhost`/`127.0.0.1`), que é onde o dublê do provedor responde nas
 * provas de tela (`ZERNIO_API_BASE_URL`) — nenhum endereço de fora passa em http.
 */
function enderecoSeguro(url: string): boolean {
  const u = new URL(url);
  return (
    u.protocol === "https:" ||
    (u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname))
  );
}

/**
 * A URL da página de cadastro hospedada pelo provedor (`signup=hosted`): ela
 * abre a janela da Meta e conecta o número escolhido. `onboarding` escolhe a
 * tela da Meta: `business_app` (coexistência, pede o QR no celular) ou `api`
 * (número só na nuvem).
 */
export async function urlDaPaginaDeConexao(chave: string, p: PaginaDeConexao): Promise<string> {
  const query = new URLSearchParams({
    profileId: p.profileId,
    redirect_url: p.redirectUrl,
    onboarding: p.coexistencia ? "business_app" : "api",
    signup: "hosted",
    brandName: p.marca.trim().slice(0, 60) || "CRM",
    language: idiomaDaPagina(p.idioma),
  });
  if (p.cor && /^#[0-9a-fA-F]{6}$/.test(p.cor)) query.set("primaryColor", p.cor);
  const { authUrl } = z
    .object({ authUrl: z.string().url() })
    .parse(await pedirAoProvedor(chave, `connect/whatsapp?${query.toString()}`));
  if (!enderecoSeguro(authUrl))
    throw new ErroDoProvedor("O provedor devolveu um endereço inseguro.");
  return authUrl;
}

const contasSchema = z.object({
  accounts: z.array(
    z.object({
      _id: z.string(),
      platform: z.string(),
      username: z.string().nullish(),
      displayName: z.string().nullish(),
      isActive: z.boolean(),
      profileId: z.union([z.string(), z.object({ _id: z.string() })]),
    }),
  ),
});

export interface ContaConectada {
  accountId: string;
  /** E.164 com `+`, quando o provedor o informa. */
  telefone: string | null;
  nome: string | null;
}

type ContaDoProvedor = z.infer<typeof contasSchema>["accounts"][number];

/** As contas DESTE perfil, ativas ou não — o filtro do provedor é conferido de novo aqui. */
async function contasDoPerfil(chave: string, profileId: string): Promise<ContaDoProvedor[]> {
  const { accounts } = contasSchema.parse(
    await pedirAoProvedor(chave, `accounts?profileId=${encodeURIComponent(profileId)}`),
  );
  return accounts.filter(
    (a) => (typeof a.profileId === "string" ? a.profileId : a.profileId._id) === profileId,
  );
}

/** As contas de WhatsApp ativas DESTE perfil. */
async function whatsappsDoPerfil(chave: string, profileId: string): Promise<ContaDoProvedor[]> {
  return (await contasDoPerfil(chave, profileId)).filter(
    (a) => a.platform === "whatsapp" && a.isActive,
  );
}

/**
 * A conta está NESTE perfil, ativa ou não? É o que a exclusão confere antes de
 * desconectar com a chave da instalação: essa chave alcança todos os números da
 * conta do provedor, e só o que o provedor confirma no perfil da organização é
 * dela para desconectar.
 */
export async function contaEstaNoPerfil(
  chave: string,
  profileId: string,
  accountId: string,
): Promise<boolean> {
  return (await contasDoPerfil(chave, profileId)).some((a) => a._id === accountId);
}

function paraContaConectada(conta: ContaDoProvedor): ContaConectada {
  const digitos = (conta.username ?? "").replace(/\D/g, "");
  return {
    accountId: conta._id,
    telefone: digitos ? `+${digitos}` : null,
    nome: conta.displayName ?? null,
  };
}

/**
 * A conta que voltou na URL está NESTE perfil, é de WhatsApp e está ativa?
 * `null` quando não: a volta não prova nada sozinha, quem prova é o provedor.
 */
export async function contaConectadaNoPerfil(
  chave: string,
  profileId: string,
  accountId: string,
): Promise<ContaConectada | null> {
  const conta = (await whatsappsDoPerfil(chave, profileId)).find((a) => a._id === accountId);
  return conta ? paraContaConectada(conta) : null;
}

/**
 * O número que o perfil JÁ tem, se tiver. O provedor aceita um WhatsApp por
 * perfil: achado aqui, a conexão se conclui sem passar de novo pela Meta — é o
 * caminho de reconectar e o de uma volta que se perdeu no meio.
 */
export async function whatsappDoPerfil(
  chave: string,
  profileId: string,
): Promise<ContaConectada | null> {
  const [conta] = await whatsappsDoPerfil(chave, profileId);
  return conta ? paraContaConectada(conta) : null;
}

const webhooksSchema = z.object({
  webhooks: z.array(z.object({ _id: z.string(), url: z.string(), isActive: z.boolean() })),
});

/**
 * A assinatura de webhook deste número, filtrada à conta. Devolve o id.
 *
 * Reconciliada pela URL, como a das redes sociais: uma tentativa que criou a
 * assinatura e morreu antes de gravar o id não pode virar duas assinaturas
 * (cada evento chegaria em dobro).
 *
 * Achada pela URL com o MESMO segredo da sessão (`segredoNovo: false`), só
 * recebe o filtro e é religada: nenhum evento se perde no caminho. Com segredo
 * novo, ela é trocada por uma nova — a documentação do provedor não lista o
 * segredo entre os campos que a edição aceita, e uma assinatura que assina com
 * o segredo velho teria toda entrega recusada pela rota de entrada.
 */
export async function garantirWebhook(
  chave: string,
  w: { url: string; segredo: string; segredoNovo: boolean; accountId: string; nome: string },
): Promise<string> {
  const { webhooks } = webhooksSchema.parse(await pedirAoProvedor(chave, "webhooks/settings"));
  const achada = webhooks.find((h) => h.url === w.url);
  if (achada && w.segredoNovo) {
    await apagarWebhook(chave, achada._id);
  } else if (achada) {
    await pedirAoProvedor(
      chave,
      "webhooks/settings",
      { webhookId: achada._id, accountIds: [w.accountId], isActive: true },
      "PUT",
    );
    return achada._id;
  }
  const criada = z.object({ webhook: z.object({ _id: z.string() }) }).parse(
    await pedirAoProvedor(chave, "webhooks/settings", {
      name: w.nome.slice(0, 50),
      url: w.url,
      secret: w.segredo,
      events: [...EVENTOS_DO_WEBHOOK],
      accountIds: [w.accountId],
      isActive: true,
    }),
  );
  return criada.webhook._id;
}

/** 404 num DELETE é "já saiu": uma nova tentativa tem de convergir. */
async function apagarNoProvedor(chave: string, caminho: string): Promise<void> {
  try {
    await pedirAoProvedor(chave, caminho, undefined, "DELETE");
  } catch (erro) {
    if (!(erro instanceof ErroDoProvedor && erro.upstreamStatus === 404)) throw erro;
  }
}

export async function apagarWebhook(chave: string, webhookId: string): Promise<void> {
  await apagarNoProvedor(chave, `webhooks/settings?webhookId=${encodeURIComponent(webhookId)}`);
}

/** Desconecta o número do provedor: a conta deixa de contar na fatura da instalação. */
export async function desconectarConta(chave: string, accountId: string): Promise<void> {
  await apagarNoProvedor(chave, `accounts/${encodeURIComponent(accountId)}`);
}

/**
 * O motivo que o provedor acrescenta na volta (`?error=`), na língua de quem
 * opera. Desconhecido cai no genérico: o código cru do provedor não ajuda
 * ninguém a decidir o que fazer.
 */
export function motivoDaVolta(codigo: string | null): string {
  switch (codigo) {
    case "connection_cancelled":
      return "A conexão foi cancelada na janela da Meta.";
    case "one_whatsapp_per_profile":
      return "Esta organização já tem um número conectado. Remova a conexão atual antes de conectar outro.";
    case "whatsapp_number_already_connected":
    case "whatsapp_number_pinned_to_profile":
      return "Este número já está conectado em outra conta. Desconecte-o lá antes de conectar aqui.";
    case "payment_required":
      return "A conta do provedor desta instalação precisa de um meio de pagamento. Avise o administrador da instalação.";
    case "session_expired":
      return "A página de conexão expirou. Tente de novo.";
    default:
      return "A Meta não concluiu a conexão. Tente de novo.";
  }
}
