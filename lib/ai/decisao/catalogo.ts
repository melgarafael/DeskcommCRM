/**
 * A LISTA DE MODELOS DE DECISÃO DO OPENROUTER — e o que ela recusa.
 *
 * `GET /api/v1/models?output_modalities=decisions` devolve os modelos que
 * declaram a saída `decisions` (medido em 15/11/2026: 41 modelos, entre eles os
 * `:free` do Perplexity e o próprio Jev). É a fonte da verdade para "este id
 * serve como decisor?": o formulário aceita texto livre, e o que impede um id
 * inventado de virar degradação silenciosa em produção é esta conferência, na
 * ESCRITA da configuração.
 *
 * ═══ POR QUE NA ESCRITA, E NÃO NO TURNO ═══
 *
 * O turno não faz rede para escolher modelo. O dreno de eventos roda os handlers
 * em série e o clima vem antes do aviso ao atendente: uma ida ao catálogo a cada
 * mensagem somaria latência a TODA mensagem por uma decisão que muda uma vez por
 * mês. Quem confere é o PATCH, que é onde o administrador espera por uma
 * resposta — e o valor gravado já nasce conferido.
 *
 * ═══ O CATÁLOGO É PÚBLICO, E AUSENTE NÃO DERRUBA NADA ═══
 *
 * O catálogo da OpenRouter responde 200 sem credencial (é o mesmo fato que
 * `./origem` documenta: por isso a chave da OpenRouter NÃO é provada por ele).
 * Aqui isso é uma vantagem: conferir a lista não exige chave nenhuma, não
 * encosta na credencial da empresa e não pode vazar uma.
 *
 * Fora do ar, a escrita é RECUSADA com a frase do conserto e o valor que já
 * estava gravado continua valendo — o padrão é o Jev, e o decisor segue
 * respondendo. O turno nunca pergunta a este módulo: ele lê a config e chama.
 *
 * ═══ CACHE CURTO ═══
 *
 * Cinco minutos, por base. A lista muda quando o fornecedor publica modelo — e
 * um administrador que acabou de ver o modelo na tela do OpenRouter precisa que
 * ele seja aceito agora; um dia inteiro de cache daria "não existe" para um
 * modelo que existe. Cinco minutos também evitam que uma tela com vários
 * PATCHes seguidos vire uma rajada de GETs.
 */
import { z } from "zod";

import { allowlistedFetch, buildAllowlist } from "@/lib/agent-engine/edge/egress";

import { baseDaApiDoJev } from "./cliente";
import { ehModeloDoJev } from "./modelo";
import type { OrigemDoJev } from "./origem";

/** Quanto tempo a lista vale, por base. Curto o bastante para um modelo novo. */
export const CACHE_DO_CATALOGO_MS = 5 * 60 * 1000;

/** O catálogo é uma tela de configuração, não o turno: 3 s é folga de sobra. */
const TETO_DO_CATALOGO_MS = 3_000;

/**
 * Só o que interessa: o id. `output_modalities` vem porque a lista filtrada
 * deveria bastar, mas um fornecedor que ignore o filtro não pode nos fazer
 * aceitar um modelo de texto — a conferência é explícita.
 */
const catalogoSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      output_modalities: z.array(z.string()).optional(),
    }),
  ),
});

export interface ModeloDoCatalogo {
  id: string;
  /** `true` quando o fornecedor declara `decisions` para ele. */
  declaraDecisoes: boolean;
}

export type ResultadoDoCatalogo =
  | { ok: true; modelos: ModeloDoCatalogo[] }
  | { ok: false; motivo: "catalogo_indisponivel" };

export interface DependenciasDoCatalogo {
  fetchImpl?: typeof fetch;
  /** Base da API. Default: a da origem OpenRouter (`baseDaApiDoJev`). */
  baseUrl?: string;
  /** Para o teste do cache sem esperar. */
  agora?: number;
}

interface EntradaDoCache {
  base: string;
  em: number;
  modelos: ModeloDoCatalogo[];
}

let cache: EntradaDoCache | null = null;

/** Só o teste usa: força a próxima leitura a ir à rede. */
export function esquecerCatalogo(): void {
  cache = null;
}

/**
 * A lista de modelos de decisão daquela base. **Nunca lança**: rede, teto, HTML
 * de proxy e JSON torto viram `catalogo_indisponivel`, e quem chama decide o que
 * dizer ao administrador.
 */
export async function listarModelosDeDecisao(
  deps: DependenciasDoCatalogo = {},
): Promise<ResultadoDoCatalogo> {
  const base = (deps.baseUrl ?? baseDaApiDoJev("openrouter")).trim().replace(/\/+$/, "");
  const agora = deps.agora ?? Date.now();
  if (cache !== null && cache.base === base && agora - cache.em < CACHE_DO_CATALOGO_MS) {
    return { ok: true, modelos: cache.modelos };
  }

  const url = `${base}/v1/models?output_modalities=decisions`;
  const allowlist = buildAllowlist([base]);
  const fetchContido: typeof fetch = (input, init) =>
    allowlistedFetch(
      typeof input === "string" || input instanceof URL ? input : input.url,
      init,
      { allowlist, fetchImpl: deps.fetchImpl },
    );

  const abortador = new AbortController();
  const relogio = setTimeout(() => abortador.abort(), TETO_DO_CATALOGO_MS);
  try {
    const res = await fetchContido(url, { method: "GET", signal: abortador.signal });
    if (!res.ok) return { ok: false, motivo: "catalogo_indisponivel" };
    const lido = catalogoSchema.safeParse(await res.json().catch(() => null));
    if (!lido.success) return { ok: false, motivo: "catalogo_indisponivel" };
    const modelos = lido.data.data.map((m) => ({
      id: m.id,
      // Sem `output_modalities` na resposta, vale o filtro que pedimos na URL:
      // um fornecedor que não devolve o campo não está nos dizendo "não".
      declaraDecisoes: m.output_modalities === undefined || m.output_modalities.includes("decisions"),
    }));
    cache = { base, em: agora, modelos };
    return { ok: true, modelos };
  } catch {
    return { ok: false, motivo: "catalogo_indisponivel" };
  } finally {
    clearTimeout(relogio);
  }
}

/** O que a configuração pode dizer sobre o modelo, e o que a tela mostra. */
export type ConferenciaDoModelo =
  | { ok: true; modelo: string | null }
  | {
      ok: false;
      motivo: "jev_modelo_sem_decisoes" | "jev_modelo_exige_openrouter" | "jev_catalogo_fora";
      /** Texto em português: a chave do dicionário, traduzida por quem responde. */
      mensagem: string;
    };

const MENSAGEM_SEM_DECISOES =
  "Este modelo não serve como decisor: ele não declara a saída de decisões (decisions) na OpenRouter. Confira o id — o do Jev é typesafe/jev-1.13 — ou escolha um da lista de modelos de decisão.";
const MENSAGEM_EXIGE_OPENROUTER =
  "Os outros modelos de decisão são servidos pela OpenRouter. Para escolher um, troque a origem do Jev para a OpenRouter — é a mesma credencial que a sua IA de conversa usa.";
const MENSAGEM_CATALOGO_FORA =
  "Não consegui conferir a lista de modelos de decisão na OpenRouter agora, então nada foi gravado. O Jev continua como padrão; tente de novo em instantes.";

export interface PedidoDeConferencia {
  /** O que veio da tela. `null` = voltar ao padrão (o Jev). */
  modelo: string | null;
  /** A origem que valerá DEPOIS do PATCH. */
  origem: OrigemDoJev;
  deps?: DependenciasDoCatalogo;
}

/**
 * A conferência da ESCRITA — o único lugar que transforma um id em config.
 *
 *  - `null`/vazio ⇒ o padrão, sem rede: voltar ao Jev não depende do fornecedor;
 *  - o Jev, em qualquer das formas ⇒ o padrão (`null`), sem rede;
 *  - outro modelo com origem `typesafe` ⇒ recusado: a chave da TypeSafe não
 *    serve para ele, e a chamada sairia com 404 de modelo;
 *  - outro modelo com origem `openrouter` ⇒ conferido no catálogo, e recusado
 *    com a frase do que falta quando ele não declara `decisions`.
 */
export async function conferirModeloDaConfig(
  pedido: PedidoDeConferencia,
): Promise<ConferenciaDoModelo> {
  const bruto = pedido.modelo?.trim() ?? "";
  if (bruto === "") return { ok: true, modelo: null };
  // O Jev em qualquer das formas é o PADRÃO, e o padrão é a ausência do campo:
  // gravado como texto, `jev-1.13.0` (o nome da TypeSafe) sairia pela OpenRouter.
  if (ehModeloDoJev(bruto)) return { ok: true, modelo: null };
  if (pedido.origem !== "openrouter") {
    return { ok: false, motivo: "jev_modelo_exige_openrouter", mensagem: MENSAGEM_EXIGE_OPENROUTER };
  }

  const catalogo = await listarModelosDeDecisao(pedido.deps);
  if (!catalogo.ok) {
    return { ok: false, motivo: "jev_catalogo_fora", mensagem: MENSAGEM_CATALOGO_FORA };
  }
  const achado = catalogo.modelos.find((m) => m.id === bruto);
  if (achado === undefined || !achado.declaraDecisoes) {
    return { ok: false, motivo: "jev_modelo_sem_decisoes", mensagem: MENSAGEM_SEM_DECISOES };
  }
  return { ok: true, modelo: bruto };
}

/** As frases, para os testes cobrarem o texto sem copiá-lo. */
export const MENSAGENS_DO_MODELO = {
  semDecisoes: MENSAGEM_SEM_DECISOES,
  exigeOpenRouter: MENSAGEM_EXIGE_OPENROUTER,
  catalogoFora: MENSAGEM_CATALOGO_FORA,
} as const;
