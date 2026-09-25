import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";

import { assertDestinoResolvidoSeguro, ipEhEspecial } from "@/lib/automation/outbound-ip";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * OS DESTINOS INTERNOS QUE O DONO DA INSTALAÇÃO AUTORIZA — decisão 22-d, #1004.
 *
 * ═══ Por que ela existe ═══
 *
 * O PR #964 fechou a saída para a rede de dentro: `assertSafeOutboundUrl`
 * (`outbound-url.ts`) recusa `localhost`, `127.`, `10.`, `192.168.`, `169.254.`
 * e `172.16/12` pelo TEXTO da URL, e `assertDestinoResolvidoSeguro`
 * (`outbound-ip.ts`) recusa o mesmo pelo IP que o nome resolve. A proteção
 * continua de pé — o que faltava era a válvula de quem PAGA a máquina.
 *
 * ═══ As quatro regras da decisão, e onde cada uma mora ═══
 *
 * 1. **Onde a lista mora:** `platform_settings.internal_destinations`, editada
 *    em `/admin/destinos-internos`. O `.env` (`IA_DESTINOS_INTERNOS_PERMITIDOS`)
 *    é só o PISO — ver `destinosInternosAutorizados()`.
 * 2. **Para quem ela vale:** só para destino configurado pela INSTALAÇÃO. Um
 *    endereço escolhido por uma ORGANIZAÇÃO passa pela régua de sempre, esteja
 *    ou não na lista — ver o parâmetro `origem` de `motivoDaRecusaDeDestino`.
 * 3. **O que ela dispensa, e só isso:** a recusa por endereço interno. Esquema,
 *    `https` em produção e literal IPv6 continuam sendo julgados pelo guarda de
 *    sempre.
 * 4. **Por endereço resolvido:** o que se compara com a lista é o IP que o
 *    nome resolve. Por isso a lista só aceita IPv4 e faixa CIDR — um NOME na
 *    lista não autorizaria nada, e só daria a impressão de que autoriza.
 *
 * ═══ Formato ═══
 *
 * Cada entrada é um IPv4 exato (`10.1.2.7`) ou uma faixa CIDR IPv4
 * (`10.1.0.0/16`). Entrada fora desse formato é IGNORADA na leitura, e ignorar
 * é RECUSAR (fail-closed): erro de digitação no `.env` não abre a rede por
 * acidente. A tela recusa a entrada inválida antes de gravar
 * (`entradaDeDestinoValida`), então pelo banco ela não chega.
 */

/** Quem escolheu o endereço — é isso que decide se a lista vale (regra 2). */
export type OrigemDoDestino = "instalacao" | "organizacao";

/** Uma entrada já validada da lista: uma faixa IPv4 (IP exato é `/32`). */
type Faixa = { base: number; mascara: number };

/** O IPv4 como inteiro sem sinal, ou null quando o texto não é um IPv4. */
function ipv4ParaInteiro(texto: string): number | null {
  const partes = texto.split(".");
  if (partes.length !== 4) return null;
  let valor = 0;
  for (const parte of partes) {
    if (!/^\d{1,3}$/.test(parte)) return null;
    const octeto = Number(parte);
    if (octeto > 255) return null;
    valor = valor * 256 + octeto;
  }
  return valor;
}

function faixaDaEntrada(entrada: string): Faixa | null {
  const texto = entrada.trim();
  const [rede, bits, ...resto] = texto.split("/");
  if (resto.length > 0) return null;
  const base = ipv4ParaInteiro(rede ?? "");
  if (base === null) return null;
  if (bits === undefined) return { base, mascara: 0xffffffff };
  if (!/^\d{1,2}$/.test(bits) || Number(bits) > 32) return null;
  const prefixo = Number(bits);
  return { base, mascara: prefixo === 0 ? 0 : (0xffffffff << (32 - prefixo)) >>> 0 };
}

/** A tela usa isto para recusar a entrada ANTES de gravar. */
export function entradaDeDestinoValida(entrada: string): boolean {
  return faixaDaEntrada(entrada) !== null;
}

/** As entradas já validadas — o que não passa no formato simplesmente não entra. */
export function faixasDeclaradas(entradas: readonly string[]): Faixa[] {
  const saida: Faixa[] = [];
  for (const entrada of entradas) {
    const faixa = faixaDaEntrada(entrada);
    if (faixa) saida.push(faixa);
  }
  return saida;
}

/** A lista cobre este IP? Só IPv4: a lista não tem forma de declarar IPv6. */
export function listaCobreIp(ip: string, faixas: readonly Faixa[]): boolean {
  const alvo = ipv4ParaInteiro(ip);
  if (alvo === null) return false;
  return faixas.some((f) => ((alvo & f.mascara) >>> 0) === ((f.base & f.mascara) >>> 0));
}

/** O `.env` como lista: vírgula separa, espaço em volta não conta, vazio é ausente. */
export function entradasDoPiso(bruto: string = env.IA_DESTINOS_INTERNOS_PERMITIDOS): string[] {
  return bruto
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "");
}

// ─── Leitura: o banco é a fonte, o `.env` é o piso ──────────────────────────
//
// Mesmo desenho de `lib/auth/politica-de-cadastro.ts`, e pelos mesmos motivos:
// o memo mora em `globalThis` (o Next instancia o módulo mais de uma vez no
// mesmo processo), a leitura NUNCA lança, e quando o banco não responde vale o
// último valor lido com sucesso — só sem ele é que o piso entra. Uma lista que
// o dono ESVAZIOU pela tela não pode voltar a valer o `.env` durante um soluço
// do banco.

const TTL_MS = 30_000;

type Memoria = { readonly lista: readonly string[]; readonly expiraEm: number };

declare global {
  var __memoDosDestinosInternos: Memoria | undefined;
  var __ultimosDestinosInternosConhecidos: readonly string[] | undefined;
  var __geracaoDosDestinosInternos: number | undefined;
}

/** Chamada por quem ESCREVE a lista. */
export function invalidarDestinosInternos(): void {
  globalThis.__geracaoDosDestinosInternos = (globalThis.__geracaoDosDestinosInternos ?? 0) + 1;
  globalThis.__memoDosDestinosInternos = undefined;
}

/** Só para os testes: devolve o processo ao estado de quem nunca leu nada. */
export function esquecerDestinosInternos(): void {
  globalThis.__memoDosDestinosInternos = undefined;
  globalThis.__ultimosDestinosInternosConhecidos = undefined;
  globalThis.__geracaoDosDestinosInternos = undefined;
}

const avisado = new Set<string>();

function avisarUmaVez(chave: string, contexto: Record<string, unknown>): void {
  if (avisado.has(chave)) return;
  avisado.add(chave);
  logger.warn(
    "destinos internos: não deu para ler do banco; vale o último valor conhecido ou o .env",
    contexto,
  );
}

/**
 * A lista em vigor, como o dono a escreveu. NUNCA LANÇA: é lida no caminho de
 * uma saída de rede, e uma exceção aqui viraria mídia não lida sem motivo.
 */
export async function destinosInternosAutorizados(): Promise<readonly string[]> {
  const memoria = globalThis.__memoDosDestinosInternos;
  if (memoria && memoria.expiraEm > Date.now()) return memoria.lista;

  // Lida ANTES do await e conferida depois: sem isto, uma leitura em voo antes
  // de `invalidarDestinosInternos()` reinstalaria o valor pré-escrita.
  const geracao = globalThis.__geracaoDosDestinosInternos ?? 0;
  const lido = await lerDoBanco();

  if (lido !== null) globalThis.__ultimosDestinosInternosConhecidos = lido;
  const valor = lido ?? globalThis.__ultimosDestinosInternosConhecidos ?? entradasDoPiso();

  if ((globalThis.__geracaoDosDestinosInternos ?? 0) === geracao) {
    globalThis.__memoDosDestinosInternos = { lista: valor, expiraEm: Date.now() + TTL_MS };
  }
  return valor;
}

/**
 * `null` = o banco não falou. Linha ausente, ou coluna `null`, NÃO é isso: é
 * "a tela nunca foi usada", e a resposta é o piso do `.env`, com sucesso.
 */
async function lerDoBanco(): Promise<readonly string[] | null> {
  try {
    const { data, error } = await createAdminClient()
      .from("platform_settings")
      .select("internal_destinations")
      .eq("id", 1)
      .maybeSingle();

    if (error) {
      avisarUmaVez(`leitura|${error.code ?? "?"}`, { codigo: error.code, detalhe: error.message });
      return null;
    }
    const bruto = (data as { internal_destinations?: unknown } | null)?.internal_destinations;
    if (bruto === null || bruto === undefined) return entradasDoPiso();
    if (!Array.isArray(bruto) || !bruto.every((e) => typeof e === "string")) return null;
    return bruto as string[];
  } catch (erro) {
    avisarUmaVez("leitura|excecao", { detalhe: erro instanceof Error ? erro.message : String(erro) });
    return null;
  }
}

/**
 * O que a TELA precisa saber, e que `destinosInternosAutorizados()` não tem
 * como dizer: a lista veio do banco, ou é o piso do `.env`?
 *
 * Os dois estados renderizam a mesma lista e significam coisas opostas — "o
 * dono escreveu isto aqui" e "ninguém nunca abriu esta tela, e o que vale é o
 * arquivo do servidor". Sem a distinção, o dono abre a tela, vê o conteúdo do
 * `.env` e salva sem mudar nada, achando que confirmou; o que ele fez foi
 * congelar o piso no banco e desligar o `.env` para sempre. É a mesma
 * precedência que `/admin/google` explica com todas as letras na tela.
 *
 * `null` do banco não vira `null` aqui: leitura que FALHOU e leitura que
 * respondeu "nunca configurado" são indistinguíveis para quem edita, e a tela
 * de edição não é lugar de adivinhar — ela mostra o que vale agora.
 */
export async function estadoDosDestinosInternos(): Promise<{
  readonly lista: readonly string[];
  readonly vemDoPiso: boolean;
  readonly piso: readonly string[];
}> {
  const piso = entradasDoPiso();
  const doBanco = await lerListaGravada();
  return doBanco === null
    ? { lista: piso, vemDoPiso: true, piso }
    : { lista: doBanco, vemDoPiso: false, piso };
}

/** `null` = não há lista gravada pela tela (coluna nula, linha ausente, ou banco mudo). */
async function lerListaGravada(): Promise<readonly string[] | null> {
  try {
    const { data, error } = await createAdminClient()
      .from("platform_settings")
      .select("internal_destinations")
      .eq("id", 1)
      .maybeSingle();
    if (error) return null;
    const bruto = (data as { internal_destinations?: unknown } | null)?.internal_destinations;
    if (!Array.isArray(bruto) || !bruto.every((e) => typeof e === "string")) return null;
    return bruto as string[];
  } catch {
    return null;
  }
}

/**
 * Grava a lista. Devolve `false` quando o banco recusou — quem chama transforma
 * isso em mensagem na tela, nunca em silêncio. Quem valida as entradas é quem
 * chama; aqui só entra o que já passou por `entradaDeDestinoValida`.
 */
export async function gravarDestinosInternos(
  lista: readonly string[],
  atorUserId: string,
): Promise<boolean> {
  try {
    const { error } = await createAdminClient()
      .from("platform_settings")
      .upsert(
        { id: 1, internal_destinations: [...lista], updated_by: atorUserId },
        { onConflict: "id" },
      );
    if (error) {
      logger.error("destinos internos: não deu para gravar", {
        codigo: error.code,
        detalhe: error.message,
      });
      return false;
    }
    invalidarDestinosInternos();
    return true;
  } catch (erro) {
    logger.error("destinos internos: gravação falhou", {
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return false;
  }
}

// ─── A régua de destino ─────────────────────────────────────────────────────

/**
 * Por que este endereço não pode ser destino — ou `null` quando pode.
 *
 * Sem lista, ou com endereço escolhido por uma ORGANIZAÇÃO, é exatamente a
 * régua de antes: o guarda textual julga de graça o que dá para julgar sem
 * rede, e o de DNS paga a resolução para julgar o IP por trás do nome.
 *
 * Com a lista e endereço da INSTALAÇÃO, muda uma coisa só: o IP interno que a
 * lista cobre deixa de ser recusa. Tudo o mais continua como estava:
 *
 *   - o guarda textual roda inteiro, e só a recusa `private_host` é dispensada
 *     — esquema, `https` em produção e literal IPv6 seguem recusando;
 *   - TODO IP que o nome resolve é julgado. Interno e fora da lista é recusa,
 *     mesmo que outro IP do mesmo nome esteja dentro: meia autorização num
 *     destino é o jeito mais barato de furar uma autorização.
 */
export async function motivoDaRecusaDeDestino(
  endereco: string,
  origem: OrigemDoDestino,
): Promise<string | null> {
  const faixas = origem === "instalacao" ? faixasDeclaradas(await destinosInternosAutorizados()) : [];

  try {
    assertSafeOutboundUrl(endereco);
  } catch (erro) {
    const codigo = erro instanceof Error ? erro.message : String(erro);
    if (!(faixas.length > 0 && codigo === "unsafe_url:private_host")) return codigo;
  }

  const host = new URL(endereco).hostname;
  if (faixas.length === 0) {
    try {
      await assertDestinoResolvidoSeguro(host);
      return null;
    } catch (erro) {
      return erro instanceof Error ? erro.message : String(erro);
    }
  }

  let ips: string[];
  if (isIPv4(host) || isIPv6(host)) {
    ips = [host];
  } else {
    try {
      ips = (await lookup(host, { all: true })).map((r) => r.address);
    } catch {
      return "unsafe_url:dns_failed";
    }
    if (ips.length === 0) return "unsafe_url:dns_empty";
  }

  for (const ip of ips) {
    if (ipEhEspecial(ip) && !listaCobreIp(ip, faixas)) return "unsafe_url:private_ip";
  }
  return null;
}

/**
 * `fetch` para um endereço escolhido por uma ORGANIZAÇÃO e chamado por um SDK
 * (o provedor personalizado, #1642). Cada requisição passa pela régua da
 * organização ANTES de a chave sair, e redirect não é seguido: um 3xx vira
 * recusa, porque um endpoint público que redireciona levaria a chamada, e a
 * chave, para a rede interna. Julgar a cada chamada, e não só no cadastro, é o
 * que pega o nome que passou a resolver para IP interno depois de validado.
 *
 * ponytail: entre o lookup daqui e o connect do fetch sobra a janela de um
 * segundo lookup (rebinding com TTL zero). Fechá-la pede fixar o IP resolvido
 * no dispatcher do undici, e isso vale para todo o egress, não só para este.
 */
export function fetchParaDestinoDaOrganizacao(interno: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const recusa = await motivoDaRecusaDeDestino(url, "organizacao");
    if (recusa) throw new Error(recusa);
    const res = await interno(input, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) throw new Error("unsafe_url:redirect_not_followed");
    return res;
  };
}
