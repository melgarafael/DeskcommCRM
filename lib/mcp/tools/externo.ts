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
import { CONEXAO_COMPARTILHADA, escritaLiberada } from "@/lib/mcp/servidor-externo/escrita-liberada";
import { hostDoEndpoint, type ServidorMcpExterno } from "@/lib/mcp/servidor-externo/registro";
import type {
  ServidorDoAgenteNoTurno,
  ServidorDoAgenteProntoNoTurno,
} from "@/lib/mcp/servidor-externo/do-agente/carregar";
import { parametroDoDesafio } from "@/lib/mcp/servidor-externo/do-agente/oauth";
import { TIMEOUT_DA_CHAMADA_NO_TURNO_MS } from "@/lib/mcp/servidor-externo/tempos-do-turno";
import {
  nomeDaFerramentaDeAcesso,
  nomeParaOModelo,
} from "@/lib/mcp/servidor-externo/do-agente/registro";
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
 * LEITURA só com as duas metades do item 8 — ver o cabeçalho deste arquivo.
 * Uma regra só para o servidor da instalação e para os servidores do agente:
 * quem precisa saber se uma remota é leitura lê a `category` da definição que
 * sai daqui, nunca recalcula.
 */
function remotaMontaComoLeitura(
  escolha: EscolhaRemota,
  ferramenta: Pick<FerramentaRemota, "somenteLeitura">,
): boolean {
  return escolha.leitura && ferramenta.somenteLeitura === true;
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
  /**
   * Os nomes liberados para ESCRITA nesta conexão (#4445), já resolvidos pela
   * carga (`escritasLiberadas`) — a definição só carrega o veredito. Sem a
   * lista, toda escrita remota sai `escritaLiberada: false` e a ponte a recusa
   * com `escrita_nao_liberada`.
   */
  escritasLiberadas: readonly string[] = [],
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

    const ehLeitura = remotaMontaComoLeitura(escolha, ferramenta);

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
      // #4445: a escrita desta conexão só roda no atendimento se a organização
      // liberou ESTE nome (`escrita-liberada.ts`). A marca vai na definição
      // porque é a ponte que decide — e ela precisa do nome da conexão para a
      // recusa nomeada e para `metadata.conexao` na auditoria.
      remotoExterno: {
        conexao: CONEXAO_COMPARTILHADA,
        escritaLiberada: !ehLeitura && escritaLiberada(escritasLiberadas, ferramenta.name),
      },
      handler: async (input) => {
        // O ORÇAMENTO DO TURNO, aqui e não no cliente: a mesma chamada feita
        // pelo cadastro ("Testar conexão") pode esperar 15 s, quem está na
        // conversa não. Ver `tempos-do-turno.ts`.
        const resultado = await chamarFerramentaRemota(
          servidor,
          ferramenta.name,
          (input ?? {}) as Record<string, unknown>,
          { ...opcoes, timeoutMs: opcoes?.timeoutMs ?? TIMEOUT_DA_CHAMADA_NO_TURNO_MS },
        );
        return resultado.dados === undefined
          ? { texto: resultado.texto }
          : { texto: resultado.texto, dados: resultado.dados };
      },
    });
  }

  return definicoes;
}

// ─── Servidores MCP DO AGENTE (migration 9095) ───────────────────────────────

/**
 * As remotas escolhidas de UM servidor do agente, com o nome NAMESPACED que o
 * modelo vê (`<slug>__<nome>`) — dois servidores anunciando `buscar_pedido`
 * viram duas ferramentas distintas, e nenhuma colide com o catálogo compilado.
 *
 * ── Classificação ───────────────────────────────────────────────────────────
 *
 * Leitura: as duas metades de sempre (marca `leitura` do admin + `readOnlyHint`
 * do servidor). Escrita DELEGADA (`escritaDelegadaAoContato`): só quando o
 * cadastro ligou `escrita_delegada`, o servidor é `oauth_por_contato`, a
 * credencial montada é do CONTATO DO TURNO e o admin marcou `escrita`. Fora
 * disso a escrita monta como sempre, para a ponte recusá-la em turno com
 * contato (`escrita_sem_escopo_do_turno`).
 *
 * ── Falhas de autorização na chamada ────────────────────────────────────────
 *
 * 401 com token do contato: renova UMA vez e repete; caiu de novo, devolve ao
 * modelo a orientação de pedir acesso (nunca o motivo técnico do terceiro).
 * 403 `insufficient_scope`: orienta o step-up por `solicitar_acesso_<slug>`,
 * com os escopos exigidos (limitados aos do cadastro na hora de gerar o link).
 */
export function definirFerramentasDoServidorDoAgente(
  montado: ServidorDoAgenteProntoNoTurno,
  nomesOcupados: ReadonlySet<string>,
  escolhas: readonly EscolhaRemota[],
  contatoDoTurno: string | undefined,
): McpToolDefinition[] {
  const { servidor } = montado;
  const anunciadas = new Map(montado.ferramentas.map((f) => [f.name, f]));
  const oauth = servidor.modo === "oauth_por_contato";
  const credencialDoContato = oauth && contatoDoTurno !== undefined && montado.contato === contatoDoTurno;
  const definicoes: McpToolDefinition[] = [];

  for (const escolha of escolhas) {
    const ferramenta = anunciadas.get(escolha.nome);
    const nome = nomeParaOModelo(servidor.slug, escolha.nome);
    if (!ferramenta || !nome) {
      logger.warn("ferramenta escolhida do servidor MCP do agente nao montou", {
        servidor_id: servidor.id,
        ferramenta: escolha.nome,
        motivo: !ferramenta ? "nao_anunciada" : "nome_fora_do_protocolo",
      });
      continue;
    }
    if (nomesOcupados.has(nome)) continue;

    const ehLeitura = remotaMontaComoLeitura(escolha, ferramenta);
    const delegada = !ehLeitura && !escolha.leitura && servidor.escritaDelegada && credencialDoContato;

    definicoes.push({
      name: nome,
      description: `${ferramenta.description ?? ferramenta.name} (servidor MCP externo "${servidor.nome}")`,
      inputSchema: shapeDaFerramenta(ferramenta),
      category: ehLeitura ? "read" : "write",
      requiresRole: "agent",
      requiresScope: ehLeitura ? "mcp:read" : "mcp:write",
      ...(delegada ? { escritaDelegadaAoContato: true as const } : {}),
      // #4445 — a mesma marca do servidor compartilhado, com o id DESTE
      // servidor como conexão: nome igual em dois servidores do agente é
      // liberação diferente (a régua de `ids.ts`).
      remotoExterno: {
        conexao: servidor.id,
        escritaLiberada: !ehLeitura && escritaLiberada(montado.escritasLiberadas ?? [], escolha.nome),
      },
      handler: async (input) => {
        const argumentos = (input ?? {}) as Record<string, unknown>;
        let desafio: { status: number; texto: string | null } | null = null;
        const chamar = () =>
          chamarFerramentaRemota(montado.chamavel, ferramenta.name, argumentos, {
            fetch: montado.fetch,
            timeoutMs: TIMEOUT_DA_CHAMADA_NO_TURNO_MS,
            ...(montado.cabecalhos ? { cabecalhos: montado.cabecalhos } : {}),
            aoRecusar: (status, texto) => {
              desafio = { status, texto };
            },
          });
        try {
          const r = await chamar();
          return r.dados === undefined ? { texto: r.texto } : { texto: r.texto, dados: r.dados };
        } catch (err) {
          const recusa = desafio as { status: number; texto: string | null } | null;
          if (oauth && recusa?.status === 401 && montado.renovarAcesso) {
            desafio = null;
            if (await montado.renovarAcesso()) {
              try {
                const r = await chamar();
                return r.dados === undefined ? { texto: r.texto } : { texto: r.texto, dados: r.dados };
              } catch {
                // cai para a orientação abaixo
              }
            }
            return {
              texto:
                `O acesso do cliente a "${servidor.nome}" não vale mais. Use a ferramenta ` +
                `${nomeDaFerramentaDeAcesso(servidor.slug)} para gerar um novo link de autorização e envie ao cliente.`,
            };
          }
          if (oauth && recusa?.status === 403 && parametroDoDesafio(recusa.texto, "error") === "insufficient_scope") {
            const escopos = parametroDoDesafio(recusa.texto, "scope") ?? "";
            return {
              texto:
                `O acesso que o cliente deu a "${servidor.nome}" não cobre esta ação. Use a ferramenta ` +
                `${nomeDaFerramentaDeAcesso(servidor.slug)}` +
                (escopos ? ` com escopos ["${escopos.split(/\s+/).join('", "')}"]` : "") +
                " para pedir o acesso ampliado e envie o link ao cliente.",
            };
          }
          throw err;
        }
      },
    });
  }
  return definicoes;
}

/**
 * A ferramenta SINTÉTICA `solicitar_acesso_<slug>` de um servidor
 * `oauth_por_contato`, montada só em turno com contato.
 *
 * `category: "read"` de propósito: ela não escreve em registro do CRM nem no
 * terceiro — cria um pedido de autorização de uso único AMARRADO ao contato e
 * à conversa do turno (que vêm do runtime, não de argumento) e devolve o link.
 * O único argumento é `escopos` (step-up), e ele é limitado aos escopos do
 * cadastro por `escoposDoPedido`. O link é o curto da instalação; o modelo o
 * envia pelo fluxo normal de resposta, com os guardrails de sempre.
 */
export function ferramentaDeSolicitarAcesso(
  montado: ServidorDoAgenteNoTurno,
): McpToolDefinition | null {
  const pedirAcesso = montado.pedirAcesso;
  if (!pedirAcesso) return null;
  const { servidor } = montado;
  const jaAutorizado = montado.estado === "pronto";
  return {
    name: nomeDaFerramentaDeAcesso(servidor.slug),
    description: jaAutorizado
      ? `Gera um link para o cliente AMPLIAR o acesso que deu a "${servidor.nome}" (use só quando uma ferramenta desse servidor disser que o acesso não cobre a ação). Envie o link ao cliente e explique que ele vai entrar na conta dele em "${servidor.nome}".`
      : `O cliente ainda não autorizou o acesso à conta dele em "${servidor.nome}", e por isso as ferramentas desse servidor não estão disponíveis. Esta ferramenta gera um link de autorização (vale 10 minutos, uso único). Envie o link ao cliente, explique que ele vai entrar na conta dele em "${servidor.nome}" para autorizar, e que depois ele pode voltar a esta conversa.`,
    inputSchema: {
      escopos: z.array(z.string().max(128)).max(20).optional(),
    },
    category: "read",
    requiresRole: "agent",
    requiresScope: "mcp:read",
    handler: async (input) => {
      const escopos = (input as { escopos?: string[] } | undefined)?.escopos;
      const pedido = await pedirAcesso(escopos);
      if (!pedido) {
        return { texto: `Não foi possível gerar o link de autorização de "${servidor.nome}" agora. Siga a conversa sem esse acesso.` };
      }
      return {
        texto: `Link de autorização (vale 10 minutos, uso único): ${pedido.link}`,
        dados: { link: pedido.link, expira_em: pedido.expiraEm.toISOString() },
      };
    },
  };
}
