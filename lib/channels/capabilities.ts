/**
 * O ÚNICO lugar do sistema que pode conhecer a diferença entre os canais.
 *
 * Feature nenhuma pergunta *com quem* falamos — pergunta *o que o canal permite*
 * (invariante 1 de `docs/doctrine/restricao-de-canal.md`). Cada capability abaixo
 * nasce de uma diferença real e medida entre WAHA e Meta Cloud; capability que
 * ninguém consome é código morto, e o teste de matriz reprova.
 */
import type { ChannelCapabilities, ChannelProvider, NotaDeVoz, ProviderDeMensagem } from "./types";

export type { ChannelProvider, ChannelCapabilities, NotaDeVoz, ProviderDeMensagem };

/**
 * A matriz descreve o que um canal de MENSAGEM permite — por isso a chave é
 * `ProviderDeMensagem`, não `ChannelProvider`. Perguntar a uma linha de voz se
 * ela manda texto fora da janela de 24h é erro de categoria, e responder
 * qualquer coisa (inclusive tudo `false`) faria a pergunta parecer legítima.
 * `capabilitiesOf` segue falhando fechado para quem não está aqui.
 */
export const CHANNEL_CAPABILITIES: Record<ProviderDeMensagem, ChannelCapabilities> = {
  // Auto-restrição: falo quando quiser, mas o WhatsApp me bane se eu abusar.
  waha: {
    freeformOutsideWindow: true,
    requiresTemplates: false,
    // Não há WABA por trás: não existe definição aprovada para gerir.
    canManageTemplates: false,
    banRisk: true,
    minIntervalMs: null,
    voiceNote: "server-convert",
    groups: "full",
    costPerMessage: false,
    alteraMensagemEnviada: true,
    podeReagir: true,
    transmissao: false,
    // É a linha que conversa com um APARELHO pareado: a agenda salva no
    // celular está lá dentro, e o `contacts/all` a devolve paginada (#2736).
    phonebook: true,
    // Status é do WhatsApp com aparelho atrás: só a linha por QR tem o
    // endpoint de publicação. Ver `publishStatus` em `./types`.
    statusUpdates: true,
    // Sem ponte de conversão: a venda desta linha sai pela conexão direta com a Meta
    // (conjunto de dados + token). Declarar `true` ofereceria uma chave que não envia nada.
    reportaConversao: false,
    // O visto azul por id de mensagem (#5015): o NOWEB sem store só marca assim.
    marcaLidasPorMensagem: true,
  },
  // Hetero-restrição: não me banem, mas a Meta me proíbe e me cobra.
  meta_cloud: {
    freeformOutsideWindow: false,
    requiresTemplates: true,
    // A Graph API cria e edita definições; o repo hoje só ESPELHA, e é essa
    // lacuna que a capability torna visível em vez de deixar implícita.
    canManageTemplates: true,
    banRisk: false,
    minIntervalMs: 6000,
    voiceNote: "opus-only",
    groups: "limited",
    costPerMessage: true,
    alteraMensagemEnviada: false,
    podeReagir: true,
    transmissao: false,
    // Nenhuma destas linhas conversa com um aparelho pareado — não existe
    // agenda de celular a ler, e dizer `true` aqui seria um botão que só falha.
    phonebook: false,
    // A API oficial não tem endpoint de Status: o gesto só existe no app do
    // WhatsApp, atrás de um aparelho pareado. Declarar `true` aqui ofereceria
    // um botão que sempre falha (ver `publishStatus` em `./types`).
    statusUpdates: false,
    // Sem ponte de conversão: a venda desta linha sai pela conexão direta com a Meta
    // (conjunto de dados + token). Declarar `true` ofereceria uma chave que não envia nada.
    reportaConversao: false,
    marcaLidasPorMensagem: false,
  },
  // Mesma hetero-restrição do canal oficial, por baixo: é um BSP: a WABA é da
  // Meta, os templates são aprovados pela Meta e a janela de 24h é da Meta. O
  // intermediário muda o TRANSPORTE (quem endereça, como se autentica), não o
  // que o WhatsApp permite — e capability descreve o permitido, não o encanamento.
  //
  // As duas diferenças reais, medidas na doc do provider, não na intuição:
  //
  //  - `voiceNote: "opus-only"`. O provider tem um `voiceNote: true` no envio,
  //    mas exige ogg/opus mono explicitamente e NÃO converte — mesma restrição
  //    do canal oficial. Ler o campo booleano como "ele resolve para mim" é o
  //    erro que manda mp3 e entrega anexo de música.
  //  - `groups: "limited"`. Existe API de grupos, mas só em plano de uso e só
  //    para números fora de coexistência. Capability é o que a instalação MÉDIA
  //    pode fazer; prometer "full" aqui quebraria em quem não paga o plano.
  // `freeformOutsideWindow: false` está MEDIDO, não deduzido. A API aceita o
  // envio livre (200 + wamid) e a Meta recusa a ENTREGA depois, pelo webhook:
  //
  //   131047 Re-engagement message — "The 24-hour customer service window for
  //   this contact is closed. Send an approved template to re-open the
  //   conversation, or wait for the contact to message you first."
  //
  // O detalhe que engana: mandar um template NÃO abre a janela. Só o cliente
  // abre, respondendo. Quem ler o 200 como "enviado" acha que funciona.
  zernio_social: {
    freeformOutsideWindow: false,
    requiresTemplates: false,
    canManageTemplates: false,
    banRisk: false,
    minIntervalMs: 1000,
    // `none` está MEDIDO, não deduzido. Era `server-convert`, e o agente com
    // "Enviar nota de voz" ligado sintetizava mp3 e mandava pelo provedor numa
    // conversa de Instagram: HTTP 400 em TODA tentativa (instalação real,
    // 15/11/2026), cada uma virando uma bolha de áudio falhada, e a fila
    // re-tentava o turno inteiro. O texto, no mesmo canal, saía.
    //
    // A causa está na doc das duas pontas, lida em 15/11/2026:
    //  - a Meta aceita áudio de DM do Instagram em aac, m4a, wav e mp4 (até
    //    25 MB) — nem mp3 nem ogg/opus, os dois formatos que sabemos sintetizar
    //    (https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api);
    //  - o provedor documenta `voiceNote` (bolha de voz) SÓ para WhatsApp, e não
    //    lista formato de áudio nenhum para Instagram/Facebook
    //    (https://docs.zernio.com/messages/send-inbox-message).
    //
    // `none` é o valor da rede NÃO medida, o Facebook: a doc do Messenger não
    // lista formato de áudio nenhum, e prometer voz lá é prometer uma bolha que
    // falha. O Instagram, medido, sobrepõe em `NOTA_DE_VOZ_POR_REDE_SOCIAL`.
    voiceNote: "none",
    groups: "none",
    costPerMessage: true,
    alteraMensagemEnviada: false,
    podeReagir: false,
    transmissao: false,
    // Nenhuma destas linhas conversa com um aparelho pareado — não existe
    // agenda de celular a ler, e dizer `true` aqui seria um botão que só falha.
    phonebook: false,
    // A API oficial não tem endpoint de Status: o gesto só existe no app do
    // WhatsApp, atrás de um aparelho pareado. Declarar `true` aqui ofereceria
    // um botão que sempre falha (ver `publishStatus` em `./types`).
    statusUpdates: false,
    // Sem ponte de conversão: a venda desta linha sai pela conexão direta com a Meta
    // (conjunto de dados + token). Declarar `true` ofereceria uma chave que não envia nada.
    reportaConversao: false,
    marcaLidasPorMensagem: false,
  },
  zernio: {
    freeformOutsideWindow: false,
    requiresTemplates: true,
    canManageTemplates: true,
    banRisk: false,
    minIntervalMs: 6000,
    voiceNote: "opus-only",
    groups: "limited",
    costPerMessage: true,
    alteraMensagemEnviada: false,
    podeReagir: false,
    // MEDIDO em 16/10/2026 (2 destinatários, entregues em 1 a 3 s): o provedor
    // cria a transmissão, recebe os telefones e manda a todos. O valor de cada
    // variável sai LITERAL do `components` — o `variableMapping` documentado
    // chegou ao destinatário como "{{1}}", e o nome que ele guarda é o número.
    transmissao: true,
    // Nenhuma destas linhas conversa com um aparelho pareado — não existe
    // agenda de celular a ler, e dizer `true` aqui seria um botão que só falha.
    phonebook: false,
    // A API oficial não tem endpoint de Status: o gesto só existe no app do
    // WhatsApp, atrás de um aparelho pareado. Declarar `true` aqui ofereceria
    // um botão que sempre falha (ver `publishStatus` em `./types`).
    statusUpdates: false,
    // O provedor tem a ponte: reporta a venda ao conjunto de dados da Meta pela
    // conversa (`reportConversion` no adapter, `../zernio/conversoes.ts`).
    reportaConversao: true,
    marcaLidasPorMensagem: false,
  },
  // Parceiro homologado pela Meta que espelha a Cloud API (recorte do #1130):
  // a WABA, a janela de 24h e o custo são da Meta. O parceiro muda o TRANSPORTE
  // (host, token), não o que o WhatsApp permite — então o perfil é o do canal
  // oficial.
  //
  // `canManageTemplates: true`: os modelos são os da Cloud API e o parceiro
  // expõe os mesmos endpoints de catálogo; a tela cria e sincroniza por lá.
  // `requiresTemplates: true` porque a regra da Meta é real: fora da janela de
  // 24h, só modelo aprovado passa.
  datafy: {
    freeformOutsideWindow: false,
    requiresTemplates: true,
    canManageTemplates: true,
    banRisk: false,
    minIntervalMs: 6000,
    voiceNote: "opus-only",
    groups: "limited",
    costPerMessage: true,
    alteraMensagemEnviada: false,
    podeReagir: false,
    transmissao: false,
    // Nenhuma destas linhas conversa com um aparelho pareado — não existe
    // agenda de celular a ler, e dizer `true` aqui seria um botão que só falha.
    phonebook: false,
    // A API oficial não tem endpoint de Status: o gesto só existe no app do
    // WhatsApp, atrás de um aparelho pareado. Declarar `true` aqui ofereceria
    // um botão que sempre falha (ver `publishStatus` em `./types`).
    statusUpdates: false,
    // Sem ponte de conversão: a venda desta linha sai pela conexão direta com a Meta
    // (conjunto de dados + token). Declarar `true` ofereceria uma chave que não envia nada.
    reportaConversao: false,
    marcaLidasPorMensagem: false,
  },
  /**
   * Bot do Telegram (Bot API, o robô do @BotFather — issue #3440).
   *
   * ─── Por que ele NÃO é uma variação do WhatsApp ────────────────────────────
   *
   * Não há número, não há WABA, não há janela de 24h e não há modelo aprovado:
   * o bot escreve para quem o iniciou, quando quiser, e a Bot API é gratuita.
   * Por isso `freeformOutsideWindow: true` e `costPerMessage: false` — as duas
   * são MEDIDAS na doc da plataforma, não deduzidas do fato de "não ter
   * template".
   *
   * ─── As três que parecem "não se aplica" e não são ─────────────────────────
   *
   * `minIntervalMs: 1000` — o FAQ do Telegram pede ~1 mensagem por segundo por
   * conversa; um bot que responde em rajada leva `429 Too Many Requests` com
   * `retry_after`. O limite é da PLATAFORMA, que é exatamente o que este campo
   * significa.
   *
   * `voiceNote: "none"` — limite DESTA implementação, não da plataforma:
   * o `sendVoice` da Bot API também aceita MP3 e M4A, mas o adapter da v1
   * recusa todo envio que não seja texto (mídia é a T2 da issue). Era
   * "opus-only" porque o campo não tinha valor "não existe" — e o agente com
   * voz ligada sintetizava um opus que o adapter recusava, em vez de responder
   * em texto. Quando a T2 entregar áudio, este valor muda junto com o adapter.
   * `groups: "none"` é o "fora da v1" da
   * issue dito em vocabulário de capability — o bot lê `chat.type` e ignora o
   * que não for `private`.
   */
  telegram: {
    freeformOutsideWindow: true,
    requiresTemplates: false,
    canManageTemplates: false,
    banRisk: false,
    minIntervalMs: 1000,
    voiceNote: "none",
    groups: "none",
    costPerMessage: false,
    // Editar e apagar existem na Bot API (`editMessageText`/`deleteMessage`) e
    // ficam para a T2 da issue: hoje o adapter não os implementa, e a tela lê
    // esta capability para decidir se mostra o gesto.
    alteraMensagemEnviada: false,
    // `setMessageReaction` existe na Bot API e também fica para a T2: o
    // adapter da v1 não reage.
    podeReagir: false,
    transmissao: false,
    // Nenhuma destas linhas conversa com um aparelho pareado — não existe
    // agenda de celular a ler, e dizer `true` aqui seria um botão que só falha.
    phonebook: false,
    // Status é do WhatsApp: não existe neste canal.
    statusUpdates: false,
    // A conversão de venda volta à Meta pela conversa de WhatsApp; o robô do
    // Telegram não tem ponte, e `true` ofereceria uma chave que não envia nada.
    reportaConversao: false,
    marcaLidasPorMensagem: false,
  },
};

/**
 * O que assumir quando o banco NÃO diz qual é o canal — só quando a linha de
 * `channel_sessions` não pôde ser lida (a coluna é `not null default 'waha'`,
 * então uma sessão que existe sempre responde).
 *
 * Espelha o default da coluna de propósito: é o que mantém o comportamento
 * idêntico ao dos literais que as Tasks 4b/5 deixaram no código. E é o canal
 * CONSERVADOR dos dois — banRisk armado, throttle e warm-up ligados; errar para
 * o lado do meta_cloud desarmaria o anti-ban num número que pode ser banido.
 */
export const DEFAULT_CHANNEL_PROVIDER: ChannelProvider = "waha";

/**
 * Constantes nomeadas dos providers. Existem para que nenhum arquivo fora deste
 * módulo precise escrever a string — é o que o `scripts/lint-channels.ts` cobra.
 */
export const CHANNEL_PROVIDER_WAHA: ChannelProvider = "waha";
export const CHANNEL_PROVIDER_META: ChannelProvider = "meta_cloud";
export const CHANNEL_PROVIDER_SOCIAL: ChannelProvider = "zernio_social";
export const CHANNEL_PROVIDER_ZERNIO: ChannelProvider = "zernio";
/**
 * Os canais cuja entrada responde ANTES de processar a mensagem nova — o porquê
 * está em `./inbound.ts`, que o reexporta. Mora aqui, num módulo sem dependência,
 * porque o piso ocioso do cron (`lib/cron/piso-ocioso.ts`) também o lê: ele
 * pergunta se há entrada aceita a reprocessar SEM escrever o nome do canal.
 */
export const CANAIS_QUE_RESPONDEM_ANTES: readonly string[] = [CHANNEL_PROVIDER_ZERNIO];
/** Parceiro que espelha a Cloud API — canal opcional da instalação, desligado por padrão. */
export const CHANNEL_PROVIDER_DATAFY: ChannelProvider = "datafy";
/** Chamada de voz WhatsApp (spec 18). Não transporta mensagem — ver abaixo. */
export const CHANNEL_PROVIDER_WACALLS: ChannelProvider = "wacalls";
/** Bot do Telegram (Bot API, #3440) — canal de mensagem sem telefone. */
export const CHANNEL_PROVIDER_TELEGRAM: ChannelProvider = "telegram";

/**
 * O provider em que o NÚMERO é a conexão: pareado por QR, a linha só vira
 * conexão quando um aparelho lê o código. A linha morta (`FAILED`/`STOPPED`)
 * sem número, ali, é QR que ninguém leu e não ocupa a vaga do plano (#3416);
 * nos outros provedores o número não identifica a conexão. É a mesma régua dos
 * gatilhos `fn_trava_canais_do_plano` e `fn_vaga_ao_reviver_canal`.
 */
export const PROVIDER_EM_QUE_O_NUMERO_E_A_CONEXAO: ChannelProvider = CHANNEL_PROVIDER_WAHA;

/**
 * A nota de voz por REDE, no provedor que serve várias (`zernio_social`): a
 * capability é do provedor, mas o formato aceito é da rede de cada conta. A rede
 * mora na sessão (`channel_sessions.metadata.social_platform`, gravada ao ligar
 * a caixa de entrada) — cada sessão social é UMA conta de UMA rede.
 *
 * Só entra aqui rede MEDIDA. Instagram, 15/11/2026, instalação real: um WAV
 * (PCM 16 bits, mono, 24 kHz, 405.860 bytes — o mesmo cabeçalho de
 * `embrulharPcmEmWav`) mandado como `attachmentType: "audio"` voltou 200 com o
 * id de mensagem do Instagram, e tocou no aplicativo. Na mesma conversa, os
 * quatro mp3 da véspera tinham voltado 400.
 */
export const NOTA_DE_VOZ_POR_REDE_SOCIAL: Readonly<Record<string, NotaDeVoz>> = {
  instagram: "wav-only",
};

/**
 * A nota de voz que ESTE canal entrega: a da rede da sessão, quando o provedor
 * serve várias e a rede foi medida; senão, a do provedor.
 *
 * Provedor desconhecido deste build responde `none` (não promete voz) — a mesma
 * régua de `enviaNotaDeVoz` na lista de canais.
 */
export function notaDeVozDoCanal(provider: string | null, redeSocial: string | null): NotaDeVoz {
  // `Object.hasOwn`, nunca `in` nem índice cru: `constructor` e `toString`
  // existem em todo objeto, e uma rede ou provedor com esse nome viraria função.
  if (provider === CHANNEL_PROVIDER_SOCIAL && redeSocial && Object.hasOwn(NOTA_DE_VOZ_POR_REDE_SOCIAL, redeSocial)) {
    return NOTA_DE_VOZ_POR_REDE_SOCIAL[redeSocial]!;
  }
  if (!provider || !Object.hasOwn(CHANNEL_CAPABILITIES, provider)) return "none";
  return CHANNEL_CAPABILITIES[provider as ProviderDeMensagem].voiceNote;
}

/**
 * Os providers por onde MENSAGEM entra e sai — a única lista que responde
 * "este canal serve para conversar?".
 *
 * Existe porque `channel_sessions` deixou de ser só a tabela dos transportes de
 * texto quando a voz entrou nela, e ~39 leituras daquela tabela não filtram
 * provider nenhum: elas dizem "canal" e querem dizer "canal de mensagem". Sem
 * esta lista, uma organização que pareia voz vê a linha de voz virar opção no
 * seletor "Número conectado", nascer amarrada ao primeiro agente publicado,
 * contar como canal conectado no retrato da instalação e ser escolhida por uma
 * automação para mandar texto — por um canal que não manda texto.
 *
 * `satisfies` e não anotação solta: um provider novo que não seja de mensagem
 * precisa ser DECIDIDO aqui, não esquecido.
 */
export const PROVIDERS_DE_MENSAGEM = [
  "waha",
  "meta_cloud",
  "zernio",
  "zernio_social",
  "datafy",
  // Bot do Telegram (#3440): manda texto sem template a qualquer hora — o robô
  // fala com quem o iniciou. `PROVIDERS_DE_TELEFONE` fica de fora de propósito,
  // e o motivo está lá embaixo.
  "telegram",
] as const satisfies readonly ProviderDeMensagem[];

/**
 * Os providers que alcançam um APARELHO: o endereço é o TELEFONE.
 *
 * É um recorte de `PROVIDERS_DE_MENSAGEM`, e a diferença é a das REDES SOCIAIS
 * (`zernio_social`): o Instagram e o Facebook só falam com quem já escreveu, o
 * contato de lá é outro endereço (handle) e não existe telefone a discar. Quem
 * tem um número na mão e escolhe a sessão social escolheu um canal que NÃO
 * alcança o destino — e o envio fora da janela de 24h é recusado (#3358,
 * medido: "O canal recusou o envio. Confira a conexão em Conexões.").
 *
 * `satisfies` sobre o recorte declara a relação entre as duas listas: um
 * provider que não seja de mensagem não pode entrar aqui, e um provider social
 * que apareça nesta lista reprova em compilação, não em produção.
 *
 * O bot do Telegram (#3440) também fica FORA, e a lição é a mesma do #3358/#3364
 * por outro caminho: ele conversa muito bem, mas não disca, não tem telefone e
 * não alcança um número. Quem tem o número do cliente na mão e escolhe a sessão
 * do Telegram escolheu um canal que não chega ao destino — o lembrete por
 * telefone sairia por um robô que nunca falou com aquela pessoa.
 */
export const PROVIDERS_DE_TELEFONE = [
  "waha",
  "meta_cloud",
  "zernio",
  "datafy",
] as const satisfies readonly Exclude<(typeof PROVIDERS_DE_MENSAGEM)[number], "zernio_social" | "telegram">[];

/**
 * `true` quando a linha de `channel_sessions` é um canal de mensagem.
 *
 * Aceita `string | null | undefined` de propósito: quem chama está lendo uma
 * coluna do banco, que pode trazer um provider mais novo que este código (um
 * clone que atualizou o schema antes da imagem). Provider desconhecido responde
 * `false` — falhar fechado aqui significa "não use este canal para mandar
 * recado", que é o erro barato; o caro é mandar por um canal que não entrega.
 * A coluna é `not null default 'waha'`, então `null` só aparece quando a linha
 * não pôde ser lida, e aí também não há canal a usar.
 */
export function transportaMensagem(provider: string | null | undefined): boolean {
  return (PROVIDERS_DE_MENSAGEM as readonly string[]).includes(provider ?? "");
}

/**
 * O canal SABIDAMENTE recusa a nota de voz que o gravador do Inbox produz?
 *
 * É o lado humano do `voiceNote: "none"`: o agente já responde em texto nesses
 * canais, e o atendente não pode ganhar um microfone que grava, sobe e termina
 * numa bolha `failed`. O gravador sobe ogg/opus (ver
 * `lib/messaging/media/voice-transcode.ts`), e a DM do Instagram só aceita
 * aac, m4a, wav e mp4.
 *
 * Responde `true` SÓ para um canal conhecido que declarou `none`. Provider
 * ausente ou mais novo que este build fica com o microfone, como sempre esteve:
 * esconder um botão que funciona por não saber o canal é o erro mais caro aqui.
 */
export function recusaNotaDeVoz(provider: string | null | undefined): boolean {
  if (!transportaMensagem(provider)) return false;
  return recusaOGravadorDoInbox(CHANNEL_CAPABILITIES[provider as ProviderDeMensagem].voiceNote);
}

/**
 * A nota de voz do canal recusa o ogg/opus que o gravador do Inbox produz?
 *
 * `none` recusa tudo; `wav-only` (a DM do Instagram, que aceita o WAV do
 * agente) recusa o ogg/opus — o agente fala lá porque sintetiza em WAV, o
 * gravador não. Os outros dois aceitam: um converte, o outro exige opus.
 */
export function recusaOGravadorDoInbox(nota: NotaDeVoz): boolean {
  return nota === "none" || nota === "wav-only";
}

/**
 * Os providers que ESTE código conhece e que, sabidamente, não conversam.
 *
 * A diferença para `!transportaMensagem(p)` é a que separa "categoria" de
 * "falha", e ela decide o que o vigia de conexão faz com a linha:
 *
 *   - `wacalls` está aqui: ignorar em silêncio é o certo, e um aviso por sessão
 *     de voz a cada minuto seria ruído perpétuo.
 *   - um provider que o CHECK do banco já aceita e esta imagem ainda não conhece
 *     (o clone que aplicou o baseline antes de puxar a imagem nova) NÃO está
 *     aqui — ele tem de fazer barulho, porque uma conexão sem vigia e sem
 *     rastro é exatamente o buraco mudo que ninguém descobre.
 *
 * `transportaMensagem` responde `false` para os dois, e é o que se quer lá: na
 * hora de escolher por onde mandar recado, o desconhecido é tão inútil quanto a
 * voz. Aqui a pergunta é outra.
 */
export const PROVIDERS_SEM_MENSAGEM = ["wacalls"] as const;

/**
 * Erro de COMPILAÇÃO enquanto sobrar provider fora das duas listas. Provider
 * novo obriga a decidir se ele conversa — esquecer não é uma opção disponível.
 */
type ProviderNaoClassificado = Exclude<
  ChannelProvider,
  (typeof PROVIDERS_DE_MENSAGEM)[number] | (typeof PROVIDERS_SEM_MENSAGEM)[number]
>;
const _todoProviderFoiClassificado: ProviderNaoClassificado extends never ? true : never = true;
void _todoProviderFoiClassificado;

/** `true` só para provider conhecido cuja natureza não é mensagem. */
export function canalConhecidoSemMensagem(provider: string | null | undefined): boolean {
  return (PROVIDERS_SEM_MENSAGEM as readonly string[]).includes(provider ?? "");
}

/**
 * Canais que escrevem livre e mesmo assim NÃO fazem campanha.
 *
 * O bot do Telegram (#3440) manda texto a qualquer hora — por isso
 * `freeformOutsideWindow: true`, que a CONVERSA usa e que está certo —, mas só
 * para quem o iniciou, e a v1 da proposta exclui campanha. A regra mora aqui, e
 * não num `false` falso na capability de janela: mentir na janela mudaria o
 * que o atendimento pode fazer só para esconder a campanha.
 */
const PROVIDERS_SEM_CAMPANHA = ["telegram"] as const satisfies readonly ProviderDeMensagem[];

/**
 * O canal de campanha por E-MAIL (#3441, fatia E2a).
 *
 * Não é `ProviderDeMensagem`: e-mail não é um `channel_sessions` — ninguém pareia
 * um aparelho, não há janela de 24 horas, não há modelo aprovado pela plataforma
 * e não há número. O endereço vem de `contacts.email` e o remetente da conta
 * Resend da organização. Mora AQUI, e não numa condição espalhada, porque a
 * pergunta "a campanha fala por quê?" continua sendo do canal.
 *
 * A régua da conta de envio NÃO mora aqui: esta função responde só o FORMATO do
 * conteúdo. Quem sabe se a organização tem conta Resend conectada é
 * `decidirConteudo` (`lib/campanhas/conteudo-do-canal.ts`), que consulta
 * `organization_resend_accounts` e recusa com motivo próprio.
 */
export const CANAL_DE_CAMPANHA_EMAIL = "email";

/** O que uma campanha pode mandar por um canal. `null` = por este canal não há campanha. */
export type ModoDeCampanha = "text" | "template" | "email";

/**
 * Como uma CAMPANHA fala por este canal: texto livre (`text`), modelo aprovado
 * (`template`), assunto + corpo (`email`) ou não fala (`null`).
 *
 * Campanha é contato que a empresa inicia — quase sempre fora das 24 horas da
 * última mensagem do cliente. Por isso a pergunta é `freeformOutsideWindow`, e
 * não "aceita texto": o número oficial aceita texto, mas só dentro da janela.
 * Canal que nem manda texto fora da janela nem tem modelo (as redes sociais)
 * não serve para campanha nenhuma.
 *
 * Tolerante como `transportaMensagem`: provider que esta imagem não conhece
 * responde `null` em vez de lançar — a tela de campanha lista conexões, e um
 * throw apagaria a lista inteira.
 */
export function modoDeCampanhaDoCanal(
  provider: string | null | undefined,
): ModoDeCampanha | null {
  // Antes de `transportaMensagem`: e-mail não transporta mensagem de conversa,
  // e é justamente por isso que a pergunta anterior responderia `false` para ele.
  if (provider === CANAL_DE_CAMPANHA_EMAIL) return "email";
  if (!transportaMensagem(provider)) return null;
  if ((PROVIDERS_SEM_CAMPANHA as readonly string[]).includes(provider ?? "")) return null;
  try {
    const caps = capabilitiesOf(provider as ProviderDeMensagem);
    if (caps.freeformOutsideWindow) return "text";
    if (caps.requiresTemplates) return "template";
    return null;
  } catch {
    return null;
  }
}

/**
 * O canal corre risco de banimento por volume (número por QR)? É o que liga o
 * aquecimento e o teto anti-ban do ritmo. Desconhecido responde `true`: no
 * ritmo, errar para o lado de mandar devagar é o erro barato.
 */
export function canalTemRiscoDeBanimento(provider: string | null | undefined): boolean {
  if (!transportaMensagem(provider)) return true;
  try {
    return capabilitiesOf(provider as ProviderDeMensagem).banRisk;
  } catch {
    return true;
  }
}

/**
 * O provedor deste número faz a transmissão (a lista inteira de uma vez, com o
 * relatório por destinatário)? Liga a terceira velocidade da campanha.
 * Desconhecido responde `false`: sem a certeza, a campanha fica no envio que o
 * próprio sistema controla.
 */
export function canalTemTransmissao(provider: string | null | undefined): boolean {
  if (!transportaMensagem(provider)) return false;
  try {
    return capabilitiesOf(provider as ProviderDeMensagem).transmissao;
  } catch {
    return false;
  }
}

/**
 * O canal desta sessão marca como lidas mensagens específicas (#5015)? Falso para
 * provider fora da matriz, como `canalTemTransmissao`: na dúvida, o envio não lê
 * o histórico atrás de ids que ninguém vai usar.
 */
export function canalMarcaLidasPorMensagem(provider: string | null | undefined): boolean {
  if (!transportaMensagem(provider)) return false;
  try {
    return capabilitiesOf(provider as ProviderDeMensagem).marcaLidasPorMensagem;
  } catch {
    return false;
  }
}

export function capabilitiesOf(provider: ChannelProvider): ChannelCapabilities {
  const caps = CHANNEL_CAPABILITIES[provider as ProviderDeMensagem];
  // Fail-closed: provider fora da matriz não herda o default do WAHA. O tipo
  // barra em compilação; isto barra o que vem do banco em runtime.
  if (!caps) throw new Error(`unknown_channel_provider: ${provider}`);
  return caps;
}
