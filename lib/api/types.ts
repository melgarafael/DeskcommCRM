export interface ApiSuccess<T> {
  data: T;
  meta?: { cursor?: string; has_more?: boolean; total?: number; request_id?: string };
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    request_id?: string;
  };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details: Record<string, unknown> | undefined,
    public readonly requestId: string,
    message?: string,
    /**
     * `true` quando a resposta NÃO trouxe o envelope da casa (proxy, HTML de
     * erro): aí `message` é o corpo cru ou `HTTP <status>`, texto que não foi
     * escrito para quem está na tela. Quem mostra `message` ao usuário confere
     * isto antes.
     */
    public readonly semEnvelope: boolean = false,
  ) {
    super(message ?? code);
    this.name = "ApiError";
  }
}
