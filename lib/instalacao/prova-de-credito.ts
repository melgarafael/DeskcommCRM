/**
 * A chave funciona — e tem saldo?
 *
 * O produto já sabia responder a primeira metade e chamava isso de "Validada".
 * O validador bate em `GET /v1/models` de cada provedor: um endpoint de
 * LISTAGEM, que não consome crédito e responde 200 com a conta zerada. Ou seja,
 * o selo verde prova que a chave existe e é aceita — nunca que ela vai
 * funcionar. Quem instalou, viu "Validada" e recebeu erro na primeira conversa
 * não tinha como saber onde olhar.
 *
 * A única coisa que prova saldo é a coisa que o provedor cobra: uma geração.
 * Por isso a prova aqui é uma chamada real, mínima (um token), e por isso ela
 * nunca sai de graça — é explicitamente pedida, não roda num GET que a tela
 * chama sozinha.
 *
 * ⚠️ Não usa `runModelCall` de propósito: aquele caminho grava em `llm_calls` e
 * é barrado pelo orçamento mensal. Um diagnóstico não pode poluir a tabela que
 * ele mesmo lê, nem ser recusado justamente quando o operador precisa descobrir
 * por que nada funciona.
 */
import { normalizarErro } from "@/lib/agent-engine/edge/llm/run-model-call";
import {
  cabecalhosDeAtribuicaoOpenRouter,
  DEEPSEEK_ENDPOINT,
  OPENROUTER_ENDPOINT,
  REQUESTY_ENDPOINT,
} from "@/lib/agent-engine/edge/llm/providers";

export type ResultadoDaProva =
  | { ok: true }
  | {
      ok: false;
      /** Mesmos baldes da tela de Execuções — uma régua só para o mesmo erro. */
      codigo: string;
      mensagem: string;
      httpStatus: number | null;
    };

interface Requisicao {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A menor geração possível em cada provedor. `max_tokens: 1` porque o objetivo
 * é atravessar a cobrança, não obter texto.
 */
export function montarRequisicaoDeProva(
  provider: string,
  apiKey: string,
  modelo: string,
  baseUrl?: string,
): Requisicao | null {
  const msg = [{ role: "user", content: "oi" }];
  switch (provider) {
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/messages",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: { model: modelo, max_tokens: 1, messages: msg },
      };
    case "openai":
      // `max_tokens` foi descontinuado pela OpenAI: os modelos de raciocínio
      // (o1/o3, a família gpt-5) RECUSAM esse campo — "Unsupported parameter:
      // 'max_tokens' is not supported with this model. Use
      // 'max_completion_tokens' instead." — e é exatamente o modelo padrão
      // curado para este provedor (`ai_models.is_default_for_provider`) que
      // cai nessa família. `max_completion_tokens` é aceito em toda a família
      // de chat completions, raciocínio ou não, então não há motivo para
      // ramificar por modelo aqui.
      return {
        url: "https://api.openai.com/v1/chat/completions",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: { model: modelo, max_completion_tokens: 1, messages: msg },
      };
    case "openrouter":
      return {
        url: `${baseUrl ?? OPENROUTER_ENDPOINT}/chat/completions`,
        // Os mesmos cabeçalhos de atribuição dos outros dois caminhos. Este era
        // o terceiro call site de OpenRouter e tinha ficado de fora — se os
        // headers fossem requisito de funcionamento, como o corpo do PR #266
        // supôs, a prova de crédito da instalação estaria falhando hoje. Ela
        // não está: são atribuição, e por isso ficam opcionais aqui também.
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...cabecalhosDeAtribuicaoOpenRouter(),
        },
        body: { model: modelo, max_tokens: 1, messages: msg },
      };
    case "deepseek":
      // OpenAI-compatível. `max_tokens: 1` atravessa a cobrança; o corpo é uma
      // GERAÇÃO, não a listagem `GET /models` (que o validador de chave já usa).
      return {
        url: `${baseUrl ?? DEEPSEEK_ENDPOINT}/chat/completions`,
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: { model: modelo, max_tokens: 1, messages: msg },
      };
    case "requesty":
      // OpenAI-compatível. `max_tokens: 16` e não 1: os modelos da OpenAI
      // atrás do roteador recusam `max_tokens` abaixo de 16 (400, medido), e o
      // modelo mais barato do catálogo da Requesty é justamente da OpenAI.
      return {
        url: `${baseUrl ?? REQUESTY_ENDPOINT}/chat/completions`,
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: { model: modelo, max_tokens: 16, messages: msg },
      };
    // Provedor personalizado (#1642): a instalação não coleta o endereço no
    // install.sh, então sem `baseUrl` não há para onde provar — `null` é a
    // leitura honesta de "não sei testar isto aqui", e não um ok por omissão
    // (fail-closed, a mesma régua do `default` abaixo).
    case "custom":
      if (!baseUrl) return null;
      return {
        url: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        // `max_tokens: 16` e não 1: modelos da OpenAI atrás de um gateway
        // recusam menos que 16 (medido na Requesty), e este é um gateway
        // qualquer — o custo de 16 tokens é irrelevante e o risco, nenhum.
        body: { model: modelo, max_tokens: 16, messages: msg },
      };
    case "google":
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          modelo,
        )}:generateContent?key=${encodeURIComponent(apiKey)}`,
        headers: { "content-type": "application/json" },
        body: {
          contents: [{ parts: [{ text: "oi" }] }],
          generationConfig: { maxOutputTokens: 1 },
        },
      };
    default:
      // Fail-closed: provedor que este módulo não sabe cobrar não recebe um
      // "ok" por omissão — seria a frase tranquilizadora de novo.
      return null;
  }
}

/** Traduz a resposta HTTP no mesmo vocabulário de erro do runtime. */
export function classificarResposta(status: number, corpo: string): ResultadoDaProva {
  if (status >= 200 && status < 300) return { ok: true };
  // `normalizarErro` lê `status` do objeto — é a régua canônica, compartilhada
  // com a tela de Execuções, e ela também redige a mensagem do provedor (que
  // pode ecoar header de autorização em endpoint próprio).
  const err = Object.assign(new Error(corpo), { status });
  const n = normalizarErro(err);
  return {
    ok: false,
    codigo: n.error_code,
    mensagem: n.error_message,
    httpStatus: n.http_status,
  };
}

const TIMEOUT_MS = 8000;

export async function provarSaldo(
  provider: string,
  apiKey: string,
  modelo: string,
  opcoes?: { baseUrl?: string; fetchImpl?: typeof fetch },
): Promise<ResultadoDaProva> {
  const req = montarRequisicaoDeProva(provider, apiKey, modelo, opcoes?.baseUrl);
  if (!req) {
    return {
      ok: false,
      codigo: "provedor_desconhecido",
      mensagem: `Não sei como testar o provedor "${provider}".`,
      httpStatus: null,
    };
  }

  const f = opcoes?.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await f(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: ctrl.signal,
    });
    const corpo = await res.text().catch(() => "");
    return classificarResposta(res.status, corpo);
  } catch (err) {
    // Rede fora, DNS, timeout: NÃO é chave ruim, e dizer que é mandaria o
    // operador trocar uma chave que está certa.
    const n = normalizarErro(err);
    return { ok: false, codigo: n.error_code, mensagem: n.error_message, httpStatus: n.http_status };
  } finally {
    clearTimeout(timer);
  }
}
