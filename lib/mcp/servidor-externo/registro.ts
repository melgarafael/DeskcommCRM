/**
 * O registro de um servidor MCP externo (#2147) — e a leitura que o turno faz
 * antes de decidir se existe algum.
 *
 * ── O que mora onde ────────────────────────────────────────────────────────
 *
 * O ENDEREÇO continua em `organizations.settings.mcp_externo` (o jsonb de
 * sempre, merge em dois níveis, os bolsos dos outros atravessam intactos). A
 * CHAVE saiu de lá: `settings` é entregue pela RLS a todo membro da
 * organização, inclusive `viewer`, e ela ficava em claro — agora são colunas
 * cifradas na mesma linha, lidas e gravadas por `segredo.ts` (#2147, item 3).
 * Uma linha por organização, sempre lida pelo `organization_id` do run ou da
 * sessão, nunca do corpo do pedido (item 2).
 *
 * ── Por que o merge é em DOIS níveis ────────────────────────────────────────
 *
 * `settings` tem vários donos e cada um lê o jsonb INTEIRO. Espalhar e regravar
 * o objeto inteiro a partir de uma leitura velha apaga o bolso de outra pessoa
 * em silêncio (é o defeito que o comentário de `updateMarcaDaOrganizacao.ts`
 * mede para `visibility_mode`). Aqui só o bolso `mcp_externo` é escrito, e os
 * demais atravessam intactos — é o que o teste deste diretório fixa.
 *
 * ── O que é validado na LEITURA ─────────────────────────────────────────────
 *
 * Endpoint http(s), sem usuário/senha embutido e SEM querystring nem
 * fragmento (item 5): um ERP que autentica por `?token=` deixaria o segredo no
 * `api_audit_log` (append-only) e no `logger.warn` de `carregar.ts`. A
 * credencial do ERP é a `chave`, e ela agora mora cifrada. Bolso malformado vira
 * `null`, e `null` significa "não há servidor registrado": o turno segue
 * exatamente como antes, sem abrir rede nenhuma.
 */
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";

export const BOLSO_MCP_EXTERNO = "mcp_externo";

/** O que se guarda e o que se chama: endereço do servidor e chave de acesso. */
export interface ServidorMcpExterno {
  endpoint: string;
  chave: string;
}

/** O que a action de registro recebe da tela. */
export interface EntradaServidorMcpExterno {
  endpoint: string;
  chave: string;
}

function ehEndpointValido(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.trim() === "") return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  // SEGREDO NO ENDEREÇO (item 5): `?token=` e `#...` seriam gravados no bolso,
  // levados para o `api_audit_log` (append-only) e para o log de erro. Recusar
  // aqui é a única porta que não depende de lembrar em cada consumidor.
  if (url.search !== "" || url.hash !== "") return false;
  return true;
}

/**
 * O HOST do endpoint — a única parte que pode ir para log, para auditoria e
 * para a tela. `https://erp.loja:8443/mcp?token=x` vira `erp.loja:8443`, sem
 * caminho, sem query e sem fragmento.
 *
 * Devolve a própria string quando não dá para parsear: quem chama já validou,
 * e um `endpoint` malformado logado inteiro é melhor do que um "undefined"
 * escondendo o motivo.
 */
export function hostDoEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/**
 * O ENDEREÇO registrado, ou `null` — inclusive quando o bolso existe mas está
 * malformado. NUNCA lança: quem chama é o caminho quente do turno, e uma
 * configuração ruim não pode derrubar a virada de turno.
 *
 * A CHAVE não vem daqui: ela é coluna cifrada e é aberta por
 * `abrirChaveMcpExterno`, em `segredo.ts`.
 */
export function lerEndpointMcpExterno(settings: unknown): string | null {
  if (typeof settings !== "object" || settings === null) return null;
  const bruto = (settings as Record<string, unknown>)[BOLSO_MCP_EXTERNO];
  if (typeof bruto !== "object" || bruto === null) return null;
  const { endpoint } = bruto as Record<string, unknown>;
  if (!ehEndpointValido(endpoint)) return null;
  return endpoint.trim();
}

/**
 * A prova textual anti-SSRF do ENDEREÇO no cadastro (item 4): recusa literal
 * privado, IPv6 literal e `http://` em produção, antes de qualquer gravação.
 *
 * Lança `unsafe_url:*` — quem converte em erro de formulário é a action, que
 * conhece o vocabulário da tela.
 */
export function conferirEndpointSeguro(endpoint: string): void {
  if (!ehEndpointValido(endpoint)) throw new Error("unsafe_url:invalid");
  assertSafeOutboundUrl(endpoint);
}

/**
 * Merge em dois níveis: lê, troca SÓ `mcp_externo` e grava o objeto inteiro de
 * volta — os outros bolsos de `settings` saem daqui como entraram.
 *
 * VAZIO APAGA (o contrato de formulário): endpoint ou chave em branco removem a
 * chave inteira, porque deixar `{}` seria um registro que a leitura enxerga como
 * presente e o turno recusa — metade ligada, sem ninguém para dizer qual metade.
 *
 * A `chave` da entrada NÃO é gravada aqui: este função devolve só o jsonb, e o
 * segredo segue cifrado para as colunas (`segredo.ts`). A entrada continua
 * recebendo a chave porque é ela que decide apagar ou não.
 */
export function mesclarServidorMcpExterno(
  settings: unknown,
  entrada: EntradaServidorMcpExterno,
): Record<string, unknown> {
  const atual: Record<string, unknown> =
    typeof settings === "object" && settings !== null
      ? { ...(settings as Record<string, unknown>) }
      : {};

  const endpoint = entrada.endpoint.trim();
  const chave = entrada.chave.trim();
  if (endpoint === "" || chave === "") {
    delete atual[BOLSO_MCP_EXTERNO];
    return atual;
  }

  return { ...atual, [BOLSO_MCP_EXTERNO]: { endpoint } };
}
