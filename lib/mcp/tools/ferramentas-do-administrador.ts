/**
 * Capacidades que existem SÓ para quem administra, por um aplicativo conectado
 * (o ChatGPT, por exemplo) — nunca para um assistente de IA.
 *
 * Hoje: as de editar os próprios assistentes (`catalogo/agentes.ts`). Um
 * assistente que pudesse ler e reescrever as próprias instruções seria a pior
 * porta do produto; o turno já não as monta (`apenasHumano`, ver
 * `lib/ai/runtime/tools.ts`) e o papel delas é `admin`, acima do `ai_operator`
 * do assistente.
 *
 * O que esta lista acrescenta é a TELA e a CONTA DO PACOTE, pela mesma regra de
 * `ferramentas-do-harness.ts` — "o pacote não pode oferecer o que o turno joga
 * fora": a capacidade aparece no seletor do assistente como não marcável, com o
 * motivo, e não ocupa vaga quando o dono liga o pacote "evoluir". Sem isto, o
 * pacote exigia 34 vagas contra o teto de 27 e deixava de caber.
 *
 * Derivada do arquivo do catálogo, não digitada: capacidade nova de editar
 * assistentes entra aqui sozinha.
 */
import { TOOLS_AGENTES } from "./catalogo/agentes";

export const MOTIVO_SO_DO_ADMINISTRADOR =
  "Esta capacidade é de quem administra a empresa, por um aplicativo conectado como o ChatGPT. Um assistente não lê nem altera as próprias instruções.";

export const IDS_DO_ADMINISTRADOR: ReadonlySet<string> = new Set(TOOLS_AGENTES.map((t) => t.name));
