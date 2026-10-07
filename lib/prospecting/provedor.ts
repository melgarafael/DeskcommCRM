/**
 * O DESPACHANTE DA BUSCA — a #1758 torna o provedor ESCOLHA da organização,
 * e não constante de módulo.
 *
 * ─── POR QUE FICA AQUI E NÃO DENTRO DE `provider.ts` ───────────────────────
 *
 * `provider.ts` é o contrato: `EscopoDaFalha` (linha 14) e `ProspectingError`
 * (linha 16) são o que `worker.ts` e `guard.ts` leem para decidir se a fila
 * para ou se o candidato falha. Quem despacha não pode ser quem define o erro:
 * se a escolha morasse lá dentro, qualquer refactor do despacho passaria a
 * tocar o contrato. Aqui só SELECIONA uma implementação — os erros saem dos
 * provedores intactos, da mesma classe, com o mesmo status e o mesmo escopo.
 *
 * ─── DE ONDE VEM A ESCOLHA ─────────────────────────────────────────────────
 *
 * `organizations.settings.prospecting.provider`, o MESMO mecanismo de
 * `settings.llm.provider` que o motor de IA já lê (`lib/agent-engine/edge/llm/
 * credentials.ts:232`). `settings` é jsonb compartilhado e a leitura é
 * DEFENSIVA pelos mesmos motivos do irmão: qualquer chave pode chegar ali, e
 * campo com tipo errado cai no default, nunca em exception no meio de uma
 * busca. **Sem migration nenhuma** — a resposta para a pergunta 1 do corpo da
 * issue é esta opção: a escolha vive no jsonb que já existe, não em coluna nova
 * de `prospecting_settings`.
 *
 * Quem não escolheu nada (`settings` vazio, `prospecting` ausente, `provider`
 * ausente) recebe `apify`, que é o default declarado na issue: a organização
 * que nunca ouviu falar desta mudança continua com EXATAMENTE o caminho de
 * hoje, inclusive a validação da credencial em `users/me`.
 *
 * ─── A CREDENCIAL NÃO MUDA DE LUGAR ────────────────────────────────────────
 *
 * `prospecting_settings.credential_encrypted` já é por organização e já é
 * cifrada pela mesma camada (`store.ts`, `configureCredential`) — mesma
 * coluna, mesmo endereçamento, mesma cifra. Ela NÃO está presa a um provedor:
 * a escolha mora em `organizations.settings` e a chave em `prospecting_settings`,
 * e nada liga uma à outra. Trocar a escolha sem regravar a chave mandaria a
 * chave antiga ao provedor novo. Hoje só a Apify é escolhível em produção; a
 * fatia que trouxer um provedor real precisa prender a chave ao provedor dela
 * (#2174).
 */
import {
  ProspectingError,
  providerRequest,
  readResults as readResultsDaApify,
  readSearch as readSearchDaApify,
  startSearch as startSearchDaApify,
} from "./provider";
import { provedorDeTeste } from "./provedor-teste";
import type { SearchInput } from "./schema";

/** O que a campanha guarda de uma execução: id, estado e — se houver — dataset e custo. */
export interface DadosDaExecucao {
  id: string;
  status: string;
  defaultDatasetId?: string;
  usageTotalUsd?: number;
}

/**
 * A interface única do despacho (#1758, F2). Três operações, iguais para todo
 * provedor — é por elas que `worker.ts` e `guard.ts` não mudam: o chamador
 * continua recebendo a MESMA forma de retorno e os MESMOS `ProspectingError`
 * de sempre, venham de onde vierem.
 */
export interface ProvedorDeBusca {
  startSearch(chave: string, input: SearchInput): Promise<DadosDaExecucao>;
  readSearch(chave: string, id: string): Promise<DadosDaExecucao>;
  readResults(chave: string, dataset: string, limit: number): Promise<Record<string, unknown>[]>;
}

/**
 * Cada escolha traz o provedor E a régua de credencial daquela fonte.
 *
 * A validação fica no registro, e não dentro da interface de três métodos,
 * porque ela não é uma operação de busca: é a pergunta que o `configure` faz
 * antes de cifrar a chave. Para a Apify a pergunta continua sendo a MESMA de
 * sempre — `users/me`, mesma URL, mesmo comportamento (controle da issue:
 * nada muda para quem não pediu). Para o provedor de teste não há rede para
 * perguntar: a chave só precisa existir.
 */
interface RegistroDoProvedor {
  provedor: ProvedorDeBusca;
  validarCredencial: (chave: string) => Promise<void>;
}

/** O default da issue: organização sem escolha nenhuma continua na Apify. */
export const PROVEDOR_PADRAO = "apify";

const REGISTRO: Record<string, RegistroDoProvedor> = {
  apify: {
    provedor: {
      startSearch: startSearchDaApify,
      readSearch: readSearchDaApify,
      readResults: readResultsDaApify,
    },
    validarCredencial: async (chave) => {
      await providerRequest(chave, "users/me");
    },
  },
  teste: {
    provedor: provedorDeTeste,
    validarCredencial: async (chave) => {
      // Sem rede: o provedor de teste não tem o que confirmar além da chave existir.
      if (!chave.trim())
        throw new ProspectingError("Informe a chave de busca do provedor de teste.");
    },
  },
};

/** Fonte mínima do que este módulo precisa ler: uma linha de `organizations.settings`. */
export interface FonteDeSettings {
  query(sql: string, params?: unknown[]): Promise<{ rows: { settings?: unknown }[] }>;
}

/**
 * A escolha LIDA, em defensivo: `settings` é jsonb livre escrito por várias
 * telas, então nada aqui assume forma. Tipo errado, chave ausente ou valor fora
 * do catálogo só podem cair no default ou — quando a escolha EXISTE e é
 * desconhecida — falhar FECHADO, que é o padrão da casa (`provider.ts`): uma
 * escolha errada é configuração de operador, e seguir para a Apify com a chave
 * de outro provedor gastaria crédito onde ninguém pediu.
 */
function escolhaNasSettings(settings: unknown): string | null {
  if (!settings || typeof settings !== "object") return null;
  const prospeccao = (settings as Record<string, unknown>).prospecting;
  if (!prospeccao || typeof prospeccao !== "object") return null;
  const provider = (prospeccao as Record<string, unknown>).provider;
  return typeof provider === "string" && provider.trim() ? provider.trim() : null;
}

async function escolha(banco: FonteDeSettings, organizacao: string): Promise<string> {
  const { rows } = await banco.query("select settings from organizations where id=$1", [
    organizacao,
  ]);
  return escolhaNasSettings(rows[0]?.settings) ?? PROVEDOR_PADRAO;
}

/**
 * O `teste` só existe sob `NODE_ENV=test` (#2174). Ele grava empresas falsas com
 * telefones em formato válido de celular, e o worker aborda os candidatos por
 * WhatsApp quando a campanha é ativada. Em qualquer outro ambiente — inclusive
 * `NODE_ENV` ausente — a escolha cai no erro fechado de provedor desconhecido.
 * Lido a cada chamada, e não no carregamento do módulo, para o teste poder
 * provar o caminho de produção sem recarregar nada.
 */
function disponivelNesteAmbiente(nome: string): boolean {
  return nome !== "teste" || process.env.NODE_ENV === "test";
}

function registroDaEscolha(nome: string): RegistroDoProvedor {
  const registro = disponivelNesteAmbiente(nome) ? REGISTRO[nome] : undefined;
  if (!registro)
    throw new ProspectingError(
      `Provedor de busca desconhecido nesta organização: ${nome}. Corrija a escolha em settings.prospecting.provider.`,
    );
  return registro;
}

/** O provedor que ESTA organização vai chamar. Nenhuma outra é afetada pela escolha. */
export async function provedorDaOrganizacao(
  banco: FonteDeSettings,
  organizacao: string,
): Promise<ProvedorDeBusca> {
  return registroDaEscolha(await escolha(banco, organizacao)).provedor;
}

/** A régua de credencial do provedor escolhido — sem escolha, a Apify de sempre (`users/me`). */
export async function validarCredencialDaOrganizacao(
  banco: FonteDeSettings,
  organizacao: string,
  chave: string,
): Promise<void> {
  await registroDaEscolha(await escolha(banco, organizacao)).validarCredencial(chave);
}
