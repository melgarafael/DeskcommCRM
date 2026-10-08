/**
 * Ferramentas de um servidor MCP EXTERNO virando tools do turno (#2147).
 *
 * ── Por que elas passam pelo MESMO wrapMcpTool ──────────────────────────────
 *
 * Não existe um caminho paralelo para a ferramenta remota. Ela vira uma
 * `McpToolDefinition` comum — `category: "read"`, `requiresRole: "agent"`,
 * `requiresScope: "mcp:read"` — e é montada pelo mesmo `wrapMcpTool` das
 * compiladas, então herda de graça auditoria (`auditMcpToolCall`), papel,
 * escopo, higiene de uuid de aterro e o tratamento de erro que devolve texto em
 * vez de matar o turno. Um segundo caminho seria uma porta dos fundos onde
 * nada disso valeria.
 *
 * ── Como uma remota é classificada (item 8) ────────────────────────────────
 *
 * Duas metades, e as duas são necessárias:
 *
 * 1. o servidor anuncia `annotations.readOnlyHint === true` (declaração dele,
 *    capturada em `somenteLeitura` por `listarFerramentasDoServidor`);
 * 2. quem administra marcou a ferramenta como LEITURA no `tool_ids` do agente
 *    (`mcp_externo:leitura:<nome>`), que é a escolha do item 6.
 *
 * Só com as duas a ferramenta sai com `category: "read"`. O resto sai como
 * `write`, e uma escrita num turno com contato cai na conferência de escopo de
 * `pickToolsFromMcp` — recusada com `escrita_sem_escopo_do_turno` — em vez de
 * passar por fora dela. `readOnlyHint` sozinho não basta: um servidor que se
 * diga "readOnly" num `cancelar_pedido` estaria escolhendo sozinho atravessar
 * a regra da conversa.
 *
 * ── Por que o nome colide com o compilado e o remoto perde ──────────────────
 *
 * Se o ERP anunciar `crm_search_contacts`, o catálogo COMPILADO continua sendo
 * a fonte daquilo que o produto já sabe fazer: o remoto é descartado com o
 * motivo no log. O inverso — o remoto por cima — seria um servidor alheio
 * se passando por ferramenta interna, e o admin que registrou o endereço não
 * estaria trocando a implementação de um nada.
 */
import { z } from "zod";

import {
  chamarFerramentaRemota,
  type FerramentaRemota,
  type OpcoesDeChamada,
} from "@/lib/mcp/servidor-externo/chamada";
import type { EscolhaRemota } from "@/lib/mcp/servidor-externo/ids";
import { hostDoEndpoint, type ServidorMcpExterno } from "@/lib/mcp/servidor-externo/registro";
import type { McpToolDefinition } from "@/lib/mcp/types";
import { logger } from "@/lib/logger";

/**
 * O esqueleto do JSON Schema que o MCP exige (`type: object`) em Zod.
 *
 * Tipos primitivos viram os equivalentes; o resto (objeto aninhado, união,
 * formato) vira `unknown`, que aceita o que o servidor mandar. É de propósito:
 * transformar JSON Schema em Zod em profundidade é um conversor inteiro, e a
 * fatia registra e CHAMA — a validação fina do argumento remoto continua sendo
 * do servidor que conhece o próprio dado. O que não se converte aqui não é
 * recusado, é aceito como está.
 */
function campoZod(bruto: unknown): z.ZodTypeAny {
  const tipo = (bruto as { type?: unknown } | null)?.type;
  switch (tipo) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(z.unknown());
    case "object":
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}

function shapeDaFerramenta(ferramenta: FerramentaRemota): Record<string, z.ZodTypeAny> {
  const propriedades = ferramenta.inputSchema?.properties;
  if (!propriedades || typeof propriedades !== "object") return {};
  const exigidos = new Set(ferramenta.inputSchema?.required ?? []);

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [nome, bruto] of Object.entries(propriedades)) {
    // Nome que não é identificador nunca vira campo: o modelo só consegue
    // escrever o que o esquema nomeia.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(nome)) continue;
    const campo = campoZod(bruto);
    shape[nome] = exigidos.has(nome) ? campo : campo.optional();
  }
  return shape;
}

/**
 * As ferramentas remotas ESCOLHIDAS pelo agente, já convertidas.
 *
 * `nomesOcupados` é o catálogo COMPILADO inteiro (`allTools`), não só o que
 * está montado neste turno: a comparação é "isto já existe no produto?", e
 * quem não foi montado agora continua existindo amanhã.
 *
 * `escolhas` vem de `tool_ids` (`item 6`): sem escolha não há ferramenta
 * remota, mesmo com servidor registrado e anunciando dez (item 7, desligado
 * por padrão). Uma escolha cujo servidor não anuncia mais aquele nome é
 * registrada no log e ignorada — trocar de ERP não pode virar tool fantasma.
 */
export function definirFerramentasRemotas(
  servidor: ServidorMcpExterno,
  ferramentas: readonly FerramentaRemota[],
  nomesOcupados: ReadonlySet<string>,
  escolhas: readonly EscolhaRemota[],
  // JUNTA DE TESTE, mesmo sentido do `fetchImpl` de `allowlistedFetch`: o stub
  // do ERP mora em `127.0.0.1`, faixa que o guard anti-SSRF recusa. Quem chama
  // em produção NÃO passa isto, e a saída é `fetchDeSaida` (item 4).
  opcoes?: OpcoesDeChamada,
): McpToolDefinition[] {
  const definicoes: McpToolDefinition[] = [];
  const anunciadas = new Map(ferramentas.map((f) => [f.name, f]));

  for (const escolha of escolhas) {
    const ferramenta = anunciadas.get(escolha.nome);
    if (!ferramenta) {
      logger.warn("ferramenta remota escolhida pelo agente nao foi anunciada pelo servidor — desconsiderada", {
        endpoint: hostDoEndpoint(servidor.endpoint),
        ferramenta: escolha.nome,
      });
      continue;
    }
    if (nomesOcupados.has(ferramenta.name)) {
      logger.warn("ferramenta do servidor MCP externo colide com o catalogo compilado — mantida a compilada", {
        endpoint: hostDoEndpoint(servidor.endpoint),
        ferramenta: ferramenta.name,
      });
      continue;
    }

    // LEITURA só com as duas metades do item 8 — ver o cabeçalho deste arquivo.
    const ehLeitura = escolha.leitura && ferramenta.somenteLeitura === true;

    definicoes.push({
      name: ferramenta.name,
      // O sufixo diz de ONDE o dado vem: o modelo não pode tratar preço vindo
      // do ERP como se viesse do catálogo do CRM, e o leitor do turno tem o
      // direito de saber que aquilo é consulta a outro sistema.
      description: `${ferramenta.description ?? ferramenta.name} (servidor MCP externo)`,
      inputSchema: shapeDaFerramenta(ferramenta),
      category: ehLeitura ? "read" : "write",
      requiresRole: "agent",
      requiresScope: ehLeitura ? "mcp:read" : "mcp:write",
      handler: async (input) => {
        const resultado = await chamarFerramentaRemota(
          servidor,
          ferramenta.name,
          (input ?? {}) as Record<string, unknown>,
          opcoes,
        );
        return resultado.dados === undefined
          ? { texto: resultado.texto }
          : { texto: resultado.texto, dados: resultado.dados };
      },
    });
  }

  return definicoes;
}
