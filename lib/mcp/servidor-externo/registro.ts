/**
 * O registro de um servidor MCP externo (#2147) — e a leitura que o turno faz
 * antes de decidir se existe algum.
 *
 * ── Onde ele mora, e por que sem migration ──────────────────────────────────
 *
 * `organizations.settings` é o jsonb onde a instalação já guarda configuração
 * (o mesmo bolso de `conversions` do PR #2197, o mesmo de `proposals`): a linha
 * já existe para toda organização, então registrar um servidor é gravar uma
 * chave — não é abrir coluna. Nada em `supabase/` é tocado por esta fatia.
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
 * Endpoint http(s) e chave preenchida. URL sem esquema, `ftp://`, chave vazia
 * ou bolso malformado viram `null`, e `null` significa "não há servidor
 * registrado": o turno segue exatamente como antes, sem abrir rede nenhuma.
 * Endpoint com usuário/senha embutido também é recusado — a credencial do ERP
 * é a `chave`, e embutir segredo em URL faria o host aparecer em log, em
 * histórico de git e na tela.
 */
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
  return url.username === "" && url.password === "";
}

/**
 * O servidor registrado, ou `null` — inclusive quando o bolso existe mas está
 * malformado. NUNCA lança: quem chama é o caminho quente do turno, e uma
 * configuração ruim não pode derrubar a virada de turno.
 */
export function lerServidorMcpExterno(settings: unknown): ServidorMcpExterno | null {
  if (typeof settings !== "object" || settings === null) return null;
  const bruto = (settings as Record<string, unknown>)[BOLSO_MCP_EXTERNO];
  if (typeof bruto !== "object" || bruto === null) return null;
  const { endpoint, chave } = bruto as Record<string, unknown>;
  if (!ehEndpointValido(endpoint)) return null;
  if (typeof chave !== "string" || chave.trim() === "") return null;
  return { endpoint: endpoint.trim(), chave };
}

/**
 * Merge em dois níveis: lê, troca SÓ `mcp_externo` e grava o objeto inteiro de
 * volta — os outros bolsos de `settings` saem daqui como entraram.
 *
 * VAZIO APAGA (o contrato de formulário do PR #2197): endpoint ou chave em
 * branco removem a chave inteira, porque deixar `{}` seria um registro que a
 * leitura enxerga como presente e o turno recusa — metade ligada, sem ninguém
 * para dizer qual metade.
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

  return { ...atual, [BOLSO_MCP_EXTERNO]: { endpoint, chave } };
}
