/**
 * O QUE UMA FALHA DE ENVIO PELO NÚMERO OFICIAL QUER DIZER — E DE QUEM ELA É.
 *
 * Uma campanha manda o mesmo modelo para centenas de pessoas. Uma falha pode ser
 * DA PESSOA (ela desligou o marketing da empresa, não tem WhatsApp, a plataforma
 * limitou quantas promoções ela recebe) — e aí a campanha segue para a próxima —
 * ou do ENVIO INTEIRO (o modelo foi pausado, o número foi restringido, falta o
 * pagamento da conta) — e aí cada envio seguinte é a mesma falha repetida, com o
 * número perdendo qualidade a cada uma. A segunda pausa a campanha.
 *
 * O código vem de dois lugares, e os dois chegam aqui:
 *   - do webhook de status: o oficial direto grava o número em `error_code`
 *     (`"131050"`); o parceiro grava `error_code = <rótulo do adapter>` e o
 *     número no começo de `error_message` (`"131050 — título — explicação"`);
 *   - da recusa síncrona do envio: o adapter marca `[plataforma:131050]` no
 *     texto, ou o envio de modelo põe o código depois do prefixo do canal
 *     (`<canal>_132000: …`, `meta/send-template-for-session.ts`), ou o código
 *     do próprio parceiro (`INVALID_TEMPLATE_PARAMS`,
 *     `message_allowance_exceeded`), ou a recusa do pré-voo deste sistema
 *     (`template_not_approved`).
 *
 * Fontes (lidas em 15/10/2026):
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/per-user-limits
 *   https://docs.zernio.com/messages/create-inbox-conversation
 *
 * Nada aqui re-tenta: mandar duas vezes é pior que não mandar (doutrina do
 * `recover-stuck-messages`). A frase diz quando vale tentar de novo.
 *
 * Puro e sem I/O — a tela e o despacho importam daqui.
 */

/** Códigos que valem para o ENVIO INTEIRO: insistir só repete a falha. */
const DO_ENVIO_INTEIRO = new Set([
  // Modelo pausado ou desativado por qualidade.
  "132015",
  "132016",
  // Modelo inexistente, parâmetros fora do contrato, formato recusado.
  "132000",
  "132001",
  "132005",
  "132007",
  "132012",
  // Número restrito por spam, conta bloqueada, pagamento, marketing desligado na API.
  "131048",
  "131031",
  "368",
  "131042",
  "131063",
  "131064",
  // Recusas do parceiro antes de sair (nada foi enviado) e cota de mensagens dele.
  "INVALID_TEMPLATE_PARAMS",
  "INVALID_TEMPLATE_HEADER",
  "INVALID_TEMPLATE_BUTTON_PARAM",
  "TEMPLATE_REQUIRED",
  "message_allowance_exceeded",
  // Recusa do pré-voo deste sistema (`conferirDefinicao`).
  "template_not_approved",
]);

const CODIGO_MARCADO = /\[plataforma:([A-Za-z0-9_]+)\]/;
const CODIGO_NO_COMECO = /^\s*(\d{2,6})\b/;
const CODIGO_DEPOIS_DO_CANAL = /^\s*[a-z]+_(\d{1,6}):/;
const CODIGO_DO_PARCEIRO =
  /\b(INVALID_TEMPLATE_PARAMS|INVALID_TEMPLATE_HEADER|INVALID_TEMPLATE_BUTTON_PARAM|TEMPLATE_REQUIRED|message_allowance_exceeded)\b/;
const CODIGO_DO_PRE_VOO = /^(template_not_approved|template_missing_values)\b/;

/**
 * O código que explica a falha, ou `null` quando ela não traz nenhum.
 *
 * A ordem importa: o marcador explícito ganha de um número solto, porque a
 * recusa síncrona começa pelo status HTTP (`400 …`) e ler esse 400 como código
 * da plataforma seria ler o envelope em vez da carta.
 */
export function codigoDaPlataforma(
  errorCode: string | null | undefined,
  errorMessage: string | null | undefined,
): string | null {
  const codigo = (errorCode ?? "").trim();
  if (/^\d{2,6}$/.test(codigo)) return codigo;
  const texto = errorMessage ?? "";
  const marcado = CODIGO_MARCADO.exec(texto);
  if (marcado) return marcado[1]!;
  const preVoo = CODIGO_DO_PRE_VOO.exec(texto);
  if (preVoo) return preVoo[1]!;
  const doParceiro = CODIGO_DO_PARCEIRO.exec(texto);
  if (doParceiro) return doParceiro[1]!;
  const depoisDoCanal = CODIGO_DEPOIS_DO_CANAL.exec(texto);
  if (depoisDoCanal) return depoisDoCanal[1]!;
  const noComeco = CODIGO_NO_COMECO.exec(texto);
  if (noComeco) return noComeco[1]!;
  return null;
}

/**
 * A recusa do envio como o adapter oficial a grava, debaixo do código genérico
 * dele: `<prefixo do canal>_<código>: <texto do provedor>`. Vale para o ENVIO DE
 * MODELO (`meta/send-template-for-session.ts`, o `api_error`) e também para o
 * TEXTO LIVRE (`adapters/meta-cloud.ts`, `send`), que grava o mesmo prefixo — o
 * nome da função é do primeiro caso, o leitor serve aos dois. O código tem de 1 a
 * 6 dígitos: a plataforma tem códigos de um dígito (`4`, limite de pedidos).
 * `erro` é a recusa SEM código, e só nasce de um defeito NOSSO ao montar os
 * parâmetros do modelo (`buildComponents` em `meta/send-template.ts`) — nada saiu.
 * E `template_missing:` / `template_stale:` são a conferência contra o espelho.
 *
 * O texto do provedor sai cortado em 300 caracteres, o mesmo teto de `fraseDaFalha`.
 *
 * `codigoDaPlataforma` não lê este prefixo — e ensiná-lo mudaria também quando a
 * campanha pausa (`falhaDoEnvioInteiro`), que é decisão de outro conserto. Quem
 * só quer a FRASE (a tela da conversa) lê os dois.
 */
const RECUSA_DO_MODELO = /^(?:[a-z]+_(\d{1,6}|erro)|(template_missing|template_stale)):\s*/;

export function recusaDoEnvioDeModelo(
  errorMessage: string | null | undefined,
): { codigo: string; textoDoProvedor: string } | null {
  const texto = (errorMessage ?? "").trim();
  const achado = RECUSA_DO_MODELO.exec(texto);
  if (!achado) return null;
  return { codigo: (achado[1] ?? achado[2])!, textoDoProvedor: texto.slice(achado[0].length).slice(0, 300) };
}

/** `true` quando a falha vale para todos os envios seguintes, não só para esta pessoa. */
export function falhaDoEnvioInteiro(codigo: string | null): boolean {
  return codigo !== null && DO_ENVIO_INTEIRO.has(codigo);
}

/**
 * O provedor ou a plataforma pediram para DESACELERAR: a mensagem não saiu e
 * não tem defeito nenhum — sai de novo daqui a pouco.
 *
 *   - `130429`: a plataforma, no limite de mensagens por segundo do número;
 *   - `429` do provedor intermediado (`rate_limited`): a janela de requisições
 *     por minuto da equipe (60, 600 ou 1.200, pelo número de contas).
 *
 * `131056` (muitas para a MESMA pessoa) não entra: é por destinatário, e o
 * adaptador já o devolve como fila (`zernio_throttled`).
 */
export function ehLimiteDeVelocidade(codigo: string | null, mensagem: string | null | undefined): boolean {
  if (codigo === "130429") return true;
  const texto = mensagem ?? "";
  return /\brate_limited\b/i.test(texto) || /^zernio_[a-z_]+: 429\b/.test(texto);
}

/**
 * A frase para quem opera, por código. Em português: a tela traduz na borda
 * (`t()`), como todo texto do produto. Código sem frase própria cai no texto
 * cru que a plataforma mandou — melhor que um "erro desconhecido".
 *
 * Exportada para a tela escrever `t(FRASES_DA_PLATAFORMA[codigo] as string)`: é a
 * forma que a cerca de i18n desembrulha para cobrar o espanhol de cada frase.
 */
export const FRASES_DA_PLATAFORMA: Record<string, string> = {
  "131050": "A pessoa desligou as mensagens de marketing desta empresa no WhatsApp. Não tente de novo.",
  "131049":
    "O WhatsApp limitou quantas promoções esta pessoa recebe. Dá para tentar de novo depois de 24 horas.",
  "131026": "Não foi possível entregar: o número não tem WhatsApp ou o aplicativo está desatualizado.",
  "130472": "A pessoa faz parte de um teste do WhatsApp que não recebe esta mensagem. Não foi cobrado.",
  "131021": "O destinatário é o próprio número que envia.",
  "131047": "Passaram mais de 24 horas da última mensagem do cliente: fora da janela, só modelo aprovado.",
  "131056": "Muitas mensagens seguidas para a mesma pessoa. Espere alguns minutos.",
  "130429": "O número atingiu o limite de envio por segundo. Tente de novo em instantes.",
  "132015": "O modelo foi pausado pela plataforma por baixa qualidade.",
  "132016": "O modelo foi desativado pela plataforma.",
  "132000": "Os valores enviados não batem com as variáveis do modelo.",
  "132001": "O modelo não existe neste número com este idioma.",
  "132005": "O texto do modelo com os valores ficou longo demais.",
  "132007": "O conteúdo viola a política de modelos da plataforma.",
  "132012": "O formato de um valor não confere com o modelo (por exemplo, falta o link da imagem do cabeçalho).",
  "131048": "O número foi restringido pela plataforma por denúncias de spam.",
  "131031": "A conta do número está bloqueada na plataforma.",
  "368": "A conta do número está bloqueada temporariamente por violar as políticas.",
  "131042": "Há um problema com o pagamento da conta na plataforma.",
  "131063": "Mensagens de marketing estão desativadas para esta conta na API.",
  "131064": "O modelo foi recategorizado pela plataforma.",
  INVALID_TEMPLATE_PARAMS: "Faltam valores para as variáveis do modelo. Nada foi enviado.",
  INVALID_TEMPLATE_HEADER: "O cabeçalho do modelo não confere (tipo de mídia ou link). Nada foi enviado.",
  INVALID_TEMPLATE_BUTTON_PARAM: "O valor de um botão não confere com o modelo. Nada foi enviado.",
  TEMPLATE_REQUIRED: "O envio precisa de um modelo aprovado.",
  message_allowance_exceeded:
    "Acabou a cota mensal de mensagens do provedor do número. Cadastre um meio de pagamento lá.",
  template_not_approved: "O modelo não está aprovado na plataforma neste momento.",
  template_missing_values: "Falta o valor de uma variável do modelo para este contato.",
  // A conferência contra o espelho (`send-template-for-session.ts`), não a plataforma.
  template_missing: "Este modelo não está na lista de modelos do número. Sincronize em Conexões, na aba Modelos.",
  template_stale: "O modelo mudou na plataforma depois de configurado. Configure o envio de novo.",
  // Acesso e limite da aplicação: a recusa do envio (`<canal>_190: …`) traz estes
  // códigos, e aqui a conexão está de fato quebrada — a frase manda a Conexões.
  "190": "O acesso ao WhatsApp Oficial expirou ou foi revogado. Reconecte o número em Conexões.",
  "10": "Falta permissão para este envio no WhatsApp Oficial. Revise as permissões do número em Conexões.",
  "200": "Falta permissão para este envio no WhatsApp Oficial. Revise as permissões do número em Conexões.",
  "4": "A conexão com o WhatsApp Oficial atingiu o limite de pedidos por agora. Tente de novo mais tarde.",
};

export function fraseDaFalha(codigo: string | null, textoCru: string | null | undefined): string | null {
  if (codigo !== null && Object.hasOwn(FRASES_DA_PLATAFORMA, codigo)) return FRASES_DA_PLATAFORMA[codigo]!;
  const cru = (textoCru ?? "").trim();
  return cru === "" ? null : cru.slice(0, 300);
}

/**
 * A ESPERA QUE O CANAL PEDIU antes de tentar de novo.
 *
 * O provedor intermediado responde `429` com `Retry-After` quando a plataforma
 * limita a conta (changelog de 25/09/2026; OpenAPI v1.370.0, `sendInboxMessage`:
 * "Seconds until the upstream quota resets"). O adapter carimba os segundos no
 * texto do erro (`[espera:30s]`), como já carimba `[plataforma:NNN]`, e quem
 * reagenda o envio lê daqui — o número atravessa o seam sem que o envio precise
 * saber de qual canal veio.
 */
const MARCA_DE_ESPERA = /\[espera:(\d{1,6})s\]/;

export function marcaDeEspera(segundos: number | null): string {
  return segundos !== null && Number.isFinite(segundos) && segundos > 0 ? ` [espera:${Math.ceil(segundos)}s]` : "";
}

/** Em milissegundos; `null` quando o canal não pediu espera nenhuma. */
export function esperaPedidaPeloCanal(erro: string | null | undefined): number | null {
  const achado = MARCA_DE_ESPERA.exec(erro ?? "");
  return achado ? Number(achado[1]) * 1000 : null;
}

/** `Retry-After` em segundos — número ou data HTTP. `null` quando ausente ou ilegível. */
export function segundosDoRetryAfter(valor: string | null | undefined, agora: number = Date.now()): number | null {
  const bruto = (valor ?? "").trim();
  if (bruto === "") return null;
  if (/^\d+$/.test(bruto)) return Number(bruto);
  const quando = Date.parse(bruto);
  if (Number.isNaN(quando)) return null;
  return Math.max(0, Math.ceil((quando - agora) / 1000));
}
