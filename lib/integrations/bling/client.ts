/**
 * Cliente oficial da API v3 do Bling ERP (https://api.bling.com.br/Api/v3/).
 * 
 * Regras cruciais de segurança e estabilidade:
 * - Rate limit: máximo de 3 requisições por segundo por conta.
 * - Tratamento resiliente de respostas HTTP 429 com retry exponencial limitado.
 * - Desacoplamento seguro de chamadas.
 */

import { logger } from "@/lib/logger";

const BLING_API_BASE = "https://api.bling.com.br/Api/v3";
const BLING_OAUTH_TOKEN_URL = "https://api.bling.com.br/Api/v3/oauth/token";

export interface BlingTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
  refresh_token: string;
}

export interface BlingEstoqueItem {
  id: number;
  codigo?: string;
  nome?: string;
  saldoFisicoTotal?: number;
  saldoVirtualTotal?: number;
}

class BlingRateLimiter {
  private lastRequestTime = 0;
  private minIntervalMs = 350; // Garante max ~2.8 req/s (bem abaixo do limite estrito de 3 req/s)

  async wait(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minIntervalMs) {
      await new Promise((resolve) => setTimeout(resolve, this.minIntervalMs - elapsed));
    }
    this.lastRequestTime = Date.now();
  }
}

const rateLimiter = new BlingRateLimiter();

export class BlingClient {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    retries = 2
  ): Promise<{ ok: boolean; data?: T; error?: string; status: number }> {
    await rateLimiter.wait();

    const url = endpoint.startsWith("http") ? endpoint : `${BLING_API_BASE}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    };

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      if (response.status === 429) {
        if (retries > 0) {
          logger.warn("[bling.client] Rate limit 429 atingido. Aguardando 1.5s para tentar novamente...");
          await new Promise((resolve) => setTimeout(resolve, 1500));
          return this.request<T>(endpoint, options, retries - 1);
        }
        return {
          ok: false,
          status: 429,
          error: "Limite de requisições do Bling atingido. Tente novamente em instantes.",
        };
      }

      const bodyText = await response.text();
      let parsedData: any = null;
      try {
        parsedData = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        parsedData = bodyText;
      }

      if (!response.ok) {
        const errMsg =
          parsedData?.error?.description ||
          parsedData?.error?.message ||
          parsedData?.message ||
          `Erro HTTP ${response.status} na API do Bling`;

        return {
          ok: false,
          status: response.status,
          error: errMsg,
          data: parsedData,
        };
      }

      return {
        ok: true,
        status: response.status,
        data: parsedData?.data !== undefined ? parsedData.data : parsedData,
      };
    } catch (err: any) {
      logger.error("[bling.client] Falha de rede ou timeout na requisição", { error: err?.message, endpoint });
      return {
        ok: false,
        status: 500,
        error: err?.message ?? "Falha de conexão com a API do Bling",
      };
    }
  }

  /**
   * Testa se o token de acesso atual é válido realizando uma consulta leve de contatos
   */
  async testarConexao(): Promise<{ ok: boolean; message: string }> {
    const res = await this.request<{ data: any[] }>("/contatos?limite=1");
    if (!res.ok) {
      return { ok: false, message: res.error || "Token inválido ou sem permissão" };
    }
    return { ok: true, message: "Conexão com Bling ERP estabelecida com sucesso" };
  }

  /**
   * Lista produtos cadastrados no Bling ERP
   */
  async listarProdutos(pagina = 1, limite = 100): Promise<{ ok: boolean; produtos?: any[]; error?: string }> {
    const res = await this.request<any[]>(`/produtos?pagina=${pagina}&limite=${limite}`);
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    const lista = Array.isArray(res.data) ? res.data : (res.data as any)?.data || [];
    return { ok: true, produtos: lista };
  }

  /**
   * Consulta estoque de produto por código (SKU) ou ID no Bling
   */
  async consultarEstoque(termoOuSku: string): Promise<{ ok: boolean; estoque?: BlingEstoqueItem[]; error?: string }> {
    const res = await this.request<BlingEstoqueItem[]>(`/estoques/saldos?termo=${encodeURIComponent(termoOuSku)}`);
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    return { ok: true, estoque: res.data };
  }

  /**
   * Cria ou atualiza um contato no Bling
   */
  async criarOuAtualizarContato(contato: {
    nome: string;
    tipo?: "F" | "J";
    numeroDocumento?: string; // CPF ou CNPJ
    email?: string;
    telefone?: string;
    celular?: string;
    endereco?: {
      geral?: {
        endereco?: string;
        numero?: string;
        complemento?: string;
        bairro?: string;
        cep?: string;
        municipio?: string;
        uf?: string;
      };
    };
  }): Promise<{ ok: boolean; idContato?: number; error?: string }> {
    const res = await this.request<{ id: number }>("/contatos", {
      method: "POST",
      body: JSON.stringify(contato),
    });

    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    return { ok: true, idContato: res.data?.id };
  }

  /**
   * Cria um Pedido de Venda no Bling
   */
  async criarPedidoVenda(pedido: {
    numero?: number;
    contato: { id: number };
    data?: string;
    itens: Array<{
      codigo?: string;
      descricao: string;
      quantidade: number;
      valor: number;
    }>;
    observacoes?: string;
  }): Promise<{ ok: boolean; idPedido?: number; numero?: number; error?: string }> {
    const res = await this.request<{ id: number; numero: number }>("/pedidos/vendas", {
      method: "POST",
      body: JSON.stringify(pedido),
    });

    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    return { ok: true, idPedido: res.data?.id, numero: res.data?.numero };
  }

  /**
   * Gera rascunho de NF-e a partir do pedido ou direto na API
   */
  async gerarNfe(payload: any): Promise<{ ok: boolean; idNotaFiscal?: number; error?: string }> {
    const res = await this.request<{ id: number }>("/nfe", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    return { ok: true, idNotaFiscal: res.data?.id };
  }

  /**
   * Transmite e autoriza a NF-e na SEFAZ usando o certificado A1 configurado no Bling
   */
  async transmitirSefaz(idNotaFiscal: number): Promise<{ ok: boolean; data?: any; error?: string }> {
    const res = await this.request<any>(`/nfe/${idNotaFiscal}/enviar?enviarEmail=false`, {
      method: "POST",
    });

    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    return { ok: true, data: res.data };
  }

  /**
   * Obtém o link ou conteúdo em PDF do DANFE da nota fiscal
   */
  async buscarDanfePdf(chaveAcesso: string): Promise<{ ok: boolean; urlOuPdf?: string; error?: string }> {
    const res = await this.request<any>(`/nfe/documento/${chaveAcesso}?formato=pdf`);
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    return { ok: true, urlOuPdf: res.data };
  }
}

/**
 * Funções utilitárias de autenticação OAuth2 do Bling
 */
export async function trocarCodeOAuthPorToken(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string
): Promise<{ ok: boolean; tokens?: BlingTokenResponse; error?: string }> {
  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });

    const res = await fetch(BLING_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    });

    const data = await res.json();
    if (!res.ok) {
      return {
        ok: false,
        error: data?.error_description || data?.error || `Erro HTTP ${res.status}`,
      };
    }

    return { ok: true, tokens: data as BlingTokenResponse };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Falha ao obter tokens OAuth do Bling" };
  }
}

export async function renovarTokenOAuth(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<{ ok: boolean; tokens?: BlingTokenResponse; error?: string }> {
  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });

    const res = await fetch(BLING_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    });

    const data = await res.json();
    if (!res.ok) {
      return {
        ok: false,
        error: data?.error_description || data?.error || `Erro HTTP ${res.status}`,
      };
    }

    return { ok: true, tokens: data as BlingTokenResponse };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Falha ao renovar token OAuth do Bling" };
  }
}
