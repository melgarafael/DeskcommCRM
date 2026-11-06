/**
 * O ATESTADO DE ANONIMIZAÇÃO — o pedido do titular com prova de quem, quando e de onde.
 *
 * ─── Por que um DOCUMENTO, e não só o aviso em texto (#2342) ────────────────
 *
 * O aviso do art. 12.º, n.º 3 já DIZ ao titular que os dados foram apagados
 * (`lib/lgpd/avisos-do-artigo-12.ts`). O que ele não dá é o papel: um e-mail é
 * texto, e quem recebe um pedido de exclusão costuma precisar depois de algo
 * datado, com origem e responsável. Demonstrar o que foi feito com o pedido é
 * obrigação do controlador (o dever de prestar contas — LGPD art. 37 e RGPD
 * art. 5.º, 2), e a única forma de o titular guardar isso é um documento.
 *
 * ─── O documento DESCREVE o fato, e NÃO cita lei ───────────────────────────
 *
 * A citação do produto (`citacaoDaLei`, do perfil do país) é a do direito de
 * ACESSO — `LGPD Art. 18, II` no Brasil e `RGPD art. 15.º` em Portugal —, e num
 * atestado de ELIMINAÇÃO ela afirmaria um direito que o titular não exerceu
 * neste pedido (CR do mantenedor, item 2). Citar o artigo de eliminação pede
 * uma citação própria revisada, que ainda não existe; até lá o documento fala
 * só do que aconteceu. Sem a linha, o cabeçalho não diz "país sem citação
 * revisada" — frase que seria FALSA para Portugal, onde a citação existe.
 *
 * ─── Minimização: o papel não carrega a identidade do titular ──────────────
 *
 * Quem guarda o documento é o Storage, e o que ele atesta é justamente o
 * apagamento: nome, documento e contatos do titular (mesmo mascarados) seriam
 * uma cópia NOVA de dado reidentificável, sem prazo e fora do alcance da
 * cascata de exclusão (CR do mantenedor, item 1). O requerente é identificado
 * APENAS pelo protocolo do pedido — o vínculo que a trilha de auditoria conhece
 * e que o controlador reencontra. As mesmas chaves saíram da linha canônica do
 * código: o que o HMAC assina é exatamente o que o papel declara. Quem algum dia
 * decidir reimprimir a identidade assume a decisão de exposição, e ela terá de
 * voltar AQUI, na linha canônica e no renderizador — os três juntos.
 *
 * O documento do CONTROLADOR (razão social e CNPJ) sai inteiro: dado público de
 * empresa, e é ele que diz de quem é o documento.
 *
 * ─── O código de autenticidade, e o que ele NÃO é ──────────────────────────
 *
 * `codigoDeAutenticidade` é HMAC-SHA256 da linha canônica (ver `linhaCanonica`)
 * com a `LGPD_SIGNING_KEY` da instalação — a mesma chave do `pades-signer`. Ele
 * prova duas coisas que o texto sozinho não prova: (1) o documento saiu DESTA
 * instalação, porque sem a chave ninguém reproduz o código; (2) os campos
 * declarados são estes, porque um caractere editado muda o HMAC. Sem chave, o
 * código degrada para SHA-256 da MESMA linha e o rótulo impresso muda: uma
 * instalação sem chave não pode afirmar autenticidade, só integridade — e o
 * documento diz qual dos dois está lendo, em vez de exibir o mesmo selo para
 * coisas diferentes. Assinatura digital (PAdES) continua sendo do
 * `pades-signer`, com o estado que ele já reporta.
 *
 * O `sha256` do PDF NÃO entra no documento (seria referência circular: o hash
 * dos bytes muda o conteúdo que ele hasheia). Ele é gravado junto do código em
 * `lgpd_requests.result.atestado` e na trilha de auditoria, que é onde um
 * auditor confere o arquivo.
 *
 * ─── Onde este documento é emitido ────────────────────────────────────────
 *
 * Decisão de produto de 2026-10-16, confirmada no CR do PR #3321 (item 3): no
 * Brasil nada muda por enquanto — nem o aviso do art. 12.º nem este atestado.
 * A regra é UMA, `exclusaoForaDoBrasil` (abaixo), e tem dois leitores: o worker
 * (`avisaTitular`, que decide aviso e papel) e a rota de aprovação (que só grava
 * a evidência do ato quando ela vai virar papel). Duas cópias da regra seriam
 * duas respostas possíveis para a mesma pergunta.
 */
import { createHash, createHmac } from "node:crypto";

import { tagDeIdioma } from "@/lib/i18n/datas";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { PAIS_PADRAO } from "@/lib/legal/perfil-do-pais";

/** Versão do FORMATO. Entra na linha canônica: mudar o layout muda o código. */
export const VERSAO_DO_ATESTADO = "atestado-de-anonimizacao.v1";

/** Os tipos de pedido que APAGAM — os únicos que o worker de exclusão executa. */
const TIPOS_DE_EXCLUSAO: readonly string[] = ["redact", "store_redact"];

/**
 * A guarda do país (decisão de 2026-10-16): só o pedido de exclusão de uma
 * organização de FORA do Brasil avisa o titular e ganha atestado. No Brasil, e
 * em todo pedido de dados, nada disso existe — e por isso a rota de aprovação
 * também não grava quem aprovou nem de qual IP: sem papel, esse dado de quem
 * opera não teria leitor.
 */
export function exclusaoForaDoBrasil(requestType: string, codigoDoPais: string): boolean {
  return TIPOS_DE_EXCLUSAO.includes(requestType) && codigoDoPais !== PAIS_PADRAO;
}

/**
 * O instante do ato como o papel o imprime: data e hora LOCAIS, no fuso da
 * organização, com o fuso dito ao lado. O ISO em UTC continua na linha canônica
 * (é o que um auditor reproduz); impresso, ele faria o titular de Lisboa ler uma
 * hora que não é a dele. Fuso inválido no cadastro cai para UTC — e o rótulo diz
 * UTC, em vez de pôr o nome do fuso ao lado de uma hora que não é dele.
 */
export function dataHoraNoFuso(iso: string, fuso: string): string {
  const opcoes: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  };
  const instante = new Date(iso);
  // O documento é gerado no worker, sem leitor de interface: o idioma é o
  // padrão do produto, resolvido pela camada de data (nunca escrito à mão).
  const etiqueta = tagDeIdioma(IDIOMA_PADRAO);
  try {
    return `${new Intl.DateTimeFormat(etiqueta, { ...opcoes, timeZone: fuso }).format(instante)} (${fuso})`;
  } catch {
    return `${new Intl.DateTimeFormat(etiqueta, { ...opcoes, timeZone: "UTC" }).format(instante)} (UTC)`;
  }
}

/** Quem executou, de onde e quando — a evidência que o documento carrega. */
export interface EvidenciaDaExecucao {
  /**
   * O ato humano. `null` quando o pedido foi executado pelo sistema (webhook,
   * retomada do worker): aí `origem` é `automatica` e o documento diz isso, em
   * vez de inventar um responsável que não existiu.
   */
  executor: { user_id: string | null; nome: string; email: string | null; papel: string } | null;
  /** IP do ato que executou. `null` = execução automática, sem ato humano. */
  ip: string | null;
  /** Instante ISO 8601 do ato de execução (não o do recebimento). */
  em: string;
  origem: "aprovacao_manual" | "automatica";
}

/**
 * O que o documento declara — e o que ele NÃO declara.
 *
 * Não há campo para o titular: nome, documento e contato saíram do documento na
 * mesma decisão que tirou a citação de lei (CR do mantenedor, itens 1 e 2). O
 * requerente entra no papel pelo `request_id`. Reintroduzir qualquer um deles é
 * reintroduzir uma cópia de dado reidentificável que sobrevive ao apagamento.
 */
export interface DadosDoAtestado {
  request_id: string;
  organization_id: string;
  /** Razão social do CONTROLADOR (`organizations.legal_name`). */
  organization_name: string;
  /** CNPJ do controlador, inteiro (dado público de empresa). */
  organization_document: string | null;
  /** Contato do encarregado (`organizations.dpo_email`). */
  organization_email: string | null;
  evidencia: EvidenciaDaExecucao;
  /** Escopo do pedido: o titular, ou a loja inteira. */
  escopo: "contact" | "tenant";
  /** Fuso da organização (`organizations.timezone`), para data e hora locais. */
  fuso: string;
}

/**
 * A linha canônica — o que o código assina.
 *
 * Ordem fixa, separador `|`, campo ausente vira `-` (nunca string vazia: vazio e
 * ausente não podem gerar o mesmo código). É esta função que um auditor
 * reproduz para reconferir; mudar a ordem, o separador ou a versão muda todos
 * os códigos já emitidos — por isso `VERSAO_DO_ATESTADO` vem primeiro.
 *
 * A identidade do titular NÃO entra aqui (item 1 do CR): o que o HMAC assina
 * tem de ser o que o papel declara, e o papel identifica o requerente só pelo
 * protocolo. Um campo de PII na linha canônica provaria integridade de um dado
 * que o documento não deveria guardar.
 */
export function linhaCanonica(d: DadosDoAtestado): string {
  return [
    VERSAO_DO_ATESTADO,
    d.request_id,
    d.organization_id,
    d.organization_name,
    d.organization_document ?? "-",
    d.escopo,
    d.evidencia.origem,
    d.evidencia.executor?.nome ?? "sistema",
    d.evidencia.executor?.email ?? "-",
    d.evidencia.executor?.papel ?? "-",
    d.evidencia.ip ?? "-",
    d.evidencia.em,
  ].join("|");
}

export type AlgoritmoDoCodigo = "hmac-sha256" | "sha256";

/**
 * O código de autenticidade (HMAC-SHA256) e o algoritmo que de fato o produziu.
 *
 * Sem `LGPD_SIGNING_KEY` o código degrada para SHA-256 da mesma linha: continua
 * provando que os campos não foram editados, mas NÃO prova origem (qualquer um
 * recalcula). Os dois casos são distinguidos no valor devolvido e no rótulo
 * impresso — um selo que afirmasse autenticidade sem chave seria mentira.
 */
export function codigoDeAutenticidade(
  d: DadosDoAtestado,
  chave: string | null | undefined,
): { codigo: string; algoritmo: AlgoritmoDoCodigo } {
  const linha = linhaCanonica(d);
  const segredo = (chave ?? "").trim();
  if (segredo.length > 10) {
    return {
      codigo: createHmac("sha256", segredo).update(linha).digest("hex"),
      algoritmo: "hmac-sha256",
    };
  }
  return { codigo: createHash("sha256").update(linha).digest("hex"), algoritmo: "sha256" };
}

/**
 * O código como ele é CITADO no papel e ao telefone: 16 hex em quatro blocos.
 *
 * O valor completo (64 hex) continua no arquivo e na trilha; este é o recorte
 * legível — quem liga citando o atestado lê o bloco, não uma linha de 64.
 */
export function codigoCurto(codigo: string): string {
  const limpo = codigo.replace(/[^0-9a-f]/gi, "").toUpperCase().slice(0, 16);
  return (limpo.match(/.{1,4}/g) ?? []).join("-");
}

/**
 * A DECLARAÇÃO — o parágrafo que o documento imprime.
 *
 * Texto de FATO, sem artigo e sem identidade: quem pediu (pelo protocolo), o
 * que foi feito, quando, por quem e de onde. O nome do titular não entra —
 * imprimi-lo seria guardar no papel o dado que o papel atesta apagado —, e a
 * frase diz isso em vez de deixar a leitura ambígua.
 */
export function textoDaDeclaracao(d: DadosDoAtestado): string {
  const escopo =
    d.escopo === "tenant"
      ? "os dados pessoais de todos os titulares da base desta organização"
      : "os dados pessoais do titular deste pedido";
  const executor = d.evidencia.executor
    ? `${d.evidencia.executor.nome}${d.evidencia.executor.email ? ` (${d.evidencia.executor.email})` : ""}`
    : "execução automática do sistema";
  const origem = d.evidencia.ip ? `, a partir do IP ${d.evidencia.ip}` : ", sem ato humano de origem (execução automática)";
  return [
    `Declaramos, na condição de controlador, que em cumprimento ao pedido de exclusão protocolado sob o número ${d.request_id},`,
    `${escopo} foram ANONIMIZADOS nos sistemas desta organização,`,
    `com a eliminação dos campos identificáveis, em ${dataHoraNoFuso(d.evidencia.em, d.fuso)}, por ${executor}${origem}.`,
    "Este documento não reproduz nome, documento nem contato do titular — o vínculo com o pedido é o protocolo acima.",
    "O registro desta execução é mantido em trilha de auditoria imutável para demonstração, e este documento é a prova",
    "que o requerente pode guardar. O código de autenticidade abaixo amarra este conjunto de informações ao registro.",
  ].join(" ");
}

/**
 * A evidência de execução, como o pedido a guardou (`request_payload.execucao`).
 *
 * Quem grava é o ATO humano (a rota de aprovação, que tem o IP e o usuário da
 * requisição). Sem isso, o pedido foi executado pelo sistema — webhook, cron ou
 * retomada do worker —, e o documento diz exatamente isso, com o instante da
 * execução: atestado que inventa um responsável é pior que atestado que declara
 * execução automática, porque o primeiro é falso e o segundo é verificável.
 *
 * O que chega aqui vem de JSONB (portanto `unknown`): os campos são conferidos
 * um a um, e nada é copiado sem ser string/`null` — um payload adulterado não
 * vira linha do documento.
 */
export function evidenciaDoPedido(
  execucaoGravada: unknown,
  instanteDaExecucao: string,
): EvidenciaDaExecucao {
  const bruto = execucaoGravada as
    | { origem?: unknown; executor?: { user_id?: unknown; nome?: unknown; email?: unknown; papel?: unknown } | null; ip?: unknown; em?: unknown }
    | null
    | undefined;
  const executante = bruto && typeof bruto === "object" ? bruto.executor : null;
  const nome = executante && typeof executante.nome === "string" && executante.nome.trim() !== "" ? executante.nome : null;
  if (bruto && typeof bruto === "object" && bruto.origem === "aprovacao_manual" && nome) {
    return {
      executor: {
        user_id: typeof executante?.user_id === "string" ? executante.user_id : null,
        nome,
        email: typeof executante?.email === "string" ? executante.email : null,
        papel: typeof executante?.papel === "string" ? executante.papel : "administrador",
      },
      ip: typeof bruto.ip === "string" ? bruto.ip : null,
      em: typeof bruto.em === "string" ? bruto.em : instanteDaExecucao,
      origem: "aprovacao_manual",
    };
  }
  return { executor: null, ip: null, em: instanteDaExecucao, origem: "automatica" };
}
