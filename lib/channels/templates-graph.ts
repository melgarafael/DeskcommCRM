/**
 * O CLIENTE DE MODELOS DA GRAPH, UMA VEZ SÓ — parametrizado por quem assina a
 * chamada (host e token).
 *
 * ─── Por que existe (#3635) ────────────────────────────────────────────────
 *
 * O canal intermediado Graph-compatível já criava, editava e apagava definições
 * pela tela. O canal oficial DIRETO não: quem usa a API oficial da Meta tinha de
 * sair do CRM, criar o modelo no Gerenciador do WhatsApp, esperar a aprovação e
 * voltar para sincronizar.
 *
 * A chamada é a MESMA — `POST /{waba_id}/message_templates`,
 * `POST /{template_id}` para editar e `DELETE …?name=&hsm_id=` para apagar. O
 * que muda entre os dois é só a PONTA: o host (Graph da Meta ou do parceiro) e o
 * token (da sessão oficial ou do parceiro). Isso é exatamente um parâmetro, não
 * uma segunda implementação — e duas cópias deste arquivo garantem que a
 * primeira correção de variante/idioma falte num dos lados, que é o defeito que
 * a #1734 pagou.
 *
 * O arquivo é NEUTRO de propósito: não fala de `meta_cloud` nem de parceiro
 * nenhum. Quem nomeia o transporte são os bindings em
 * `lib/channels/meta/templates.ts` e `lib/channels/graph-parceiro/templates.ts`,
 * como o invariante 1 da doutrina de restrição de canal cobra.
 */
import type {
  ChannelTemplate,
  ChannelTemplateDraft,
  ChannelTemplateOps,
  ChannelTenantScope,
} from "./types";

/** A forma que a Graph devolve. Vocabulário ABERTO: a plataforma cria campo novo. */
interface RawTemplate {
  id?: string;
  name?: string;
  language?: string;
  status?: string;
  category?: string | null;
  components?: unknown[];
  rejected_reason?: string | null;
  parameter_format?: string | null;
  error?: { message?: string; code?: number | string; type?: string };
}

/** O que o binding resolve antes de qualquer chamada: a conta e quem assina. */
export interface CredencialDosModelos {
  wabaId: string;
  token: string;
}

type Escopo = ChannelTenantScope & { sessionRef: string };

/**
 * O erro da plataforma, com o que a ROTA precisa para classificar sem ler texto.
 *
 * `status` é o HTTP dela e `codigo` o `error.code` do corpo (a Meta usa `200`
 * para "falta permissão na conta" e `190` para token vencido). O parceiro só
 * mostra `message`; o canal oficial usa os dois para dizer
 * "a conta não tem `whatsapp_business_management`" em vez de "não deu".
 */
export class ErroDeModelosDaGraph extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly codigo: string | null,
  ) {
    super(message);
    this.name = "ErroDeModelosDaGraph";
  }
}

export interface FonteDosModelos {
  /**
   * A base da API, COM a versão e SEM barra final. Função, e não valor: o host
   * é lido do ambiente a cada operação (`graphBaseUrl`), como o resto do seam
   * faz — capturar no import congelaria a configuração do processo.
   */
  base: () => string;
  /** Organização + número → conta (WABA) e token. Lança quando não há. */
  credencial: (escopo: Escopo) => Promise<CredencialDosModelos>;
  /**
   * Prefixo dos erros, para quem depura saber de onde veio sem abrir o log:
   * `graph_partner_template` / `meta_template`.
   */
  rotulo: string;
}

const CAMPOS_DA_LISTA =
  "name,language,status,category,parameter_format,rejected_reason,quality_score,components";

function toNeutral(t: RawTemplate | null): ChannelTemplate {
  const componentes = t?.components;
  return {
    name: t?.name ?? "",
    language: t?.language ?? "",
    // Vocabulário ABERTO: a plataforma cria estado novo sem avisar.
    status: t?.status ?? "UNKNOWN",
    category: t?.category ?? null,
    components: Array.isArray(componentes) ? componentes : [],
    rejectedReason: t?.rejected_reason ?? null,
    parameterFormat: t?.parameter_format ?? null,
  };
}

async function lerJson(res: Response): Promise<RawTemplate | null> {
  return (await res.json().catch(() => null)) as RawTemplate | null;
}

function erroDaGraph(
  rotulo: string,
  res: Response,
  json: RawTemplate | null,
  acao: string,
): ErroDeModelosDaGraph {
  const codigo = json?.error?.code === undefined || json?.error?.code === null ? null : String(json.error.code);
  return new ErroDeModelosDaGraph(
    `${rotulo}_${acao}: ${res.status} ${json?.error?.message ?? ""}`.trim(),
    res.status,
    codigo,
  );
}

/**
 * O cliente. Cada operação resolve a credencial do ESCOPO que recebeu — nunca
 * de um singleton —, e é isso que faz o modelo de uma WABA ser inalcançável a
 * partir de outra organização.
 */
export function operacoesDeModelos(fonte: FonteDosModelos): ChannelTemplateOps {
  const { base, credencial, rotulo } = fonte;

  function mesmaOrigem(url: string, baseDaFonte: string): boolean {
    try {
      return new URL(url).origin === new URL(baseDaFonte).origin;
    } catch {
      return false;
    }
  }

  /**
   * Varre a coleção de modelos, UMA página por vez, até o fim ou até `emCada`
   * pedir para parar.
   *
   * `paging.next` só é seguido no mesmo host (o token vai no header, e um `next`
   * apontando para fora o entregaria a quem a resposta mandasse) e o teto de
   * páginas fecha o laço se a plataforma devolver sempre o mesmo cursor.
   */
  async function varrerModelos(
    c: CredencialDosModelos,
    fields: string,
    emCada: (t: RawTemplate) => boolean,
    nome?: string,
  ): Promise<void> {
    const baseDaFonte = base();
    // `name` é filtro DOCUMENTADO da plataforma e devolve o nome em TODOS os
    // idiomas — daí o idioma casar aqui dentro e não no servidor.
    const filtro = nome ? `&name=${encodeURIComponent(nome)}` : "";
    let url: string | null = `${baseDaFonte}/${encodeURIComponent(c.wabaId)}/message_templates?limit=100&fields=${fields}${filtro}`;

    for (let pagina = 0; pagina < 50 && url; pagina += 1) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${c.token}` } });
      const json = (await res.json().catch(() => null)) as
        | (RawTemplate & { data?: RawTemplate[]; paging?: { next?: string } })
        | null;
      if (!res.ok || json?.error) throw erroDaGraph(rotulo, res, json, "failed");
      for (const t of json?.data ?? []) {
        if (!emCada(t)) return;
      }
      const proxima = json?.paging?.next;
      url = proxima && proxima !== url && mesmaOrigem(proxima, baseDaFonte) ? proxima : null;
    }
  }

  /**
   * O id da UMA variante — nome e idioma JUNTOS.
   *
   * A plataforma numera cada variante de idioma por conta própria: o mesmo
   * `name` em `pt_BR` e `en_US` são DOIS ids, e é por eles que se fala com uma
   * só (`POST /{template_id}` para editar, `DELETE …&hsm_id=` para apagar). Sem
   * o id a única chave que sobra é o nome — e por nome o DELETE leva TODAS as
   * variantes (#1734), que é o defeito que este helper existe para fechar.
   *
   * Sem a variante não há id, e SEM ID A OPERAÇÃO NÃO SAI DO LUGAR: lança com o
   * motivo, em vez de chamar a plataforma no escuro.
   */
  async function idDaVariante(
    c: CredencialDosModelos,
    name: string,
    language: string,
  ): Promise<string> {
    const achados: string[] = [];
    await varrerModelos(
      c,
      "id,name,language",
      (t) => {
        if (t.id && t.name === name && t.language === language) {
          achados.push(t.id);
          return false;
        }
        return true;
      },
      name,
    );
    const id = achados[0];
    if (!id) {
      throw new ErroDeModelosDaGraph(
        `${rotulo}_variante_ausente: ${name} (${language}) não está nesta conta.`,
        null,
        null,
      );
    }
    return id;
  }

  /**
   * POST num caminho da API, relativo à base: `/{waba}/message_templates` para
   * criar e `/{template_id}` para editar — este SEM o waba_id, que a plataforma
   * não quer no caminho da edição. Devolve o que ela devolver (pode vir vazio).
   */
  async function postar(
    c: CredencialDosModelos,
    caminho: string,
    body: Record<string, unknown>,
  ): Promise<ChannelTemplate> {
    const baseDaFonte = base();
    const url = `${baseDaFonte}${caminho}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await lerJson(res);
    if (!res.ok || json?.error) throw erroDaGraph(rotulo, res, json, "failed");
    return toNeutral(json);
  }

  return {
    async list({ organizationId, sessionRef }): Promise<ChannelTemplate[]> {
      const c = await credencial({ organizationId, sessionRef });
      const todos: ChannelTemplate[] = [];
      await varrerModelos(c, CAMPOS_DA_LISTA, (t) => {
        todos.push(toNeutral(t));
        return true;
      });
      return todos;
    },

    async create({ organizationId, sessionRef, draft }): Promise<ChannelTemplate> {
      const c = await credencial({ organizationId, sessionRef });
      return postar(c, `/${encodeURIComponent(c.wabaId)}/message_templates`, {
        name: draft.name,
        language: draft.language,
        category: draft.category,
        components: draft.components,
        ...(draft.parameterFormat ? { parameter_format: draft.parameterFormat } : {}),
      });
    },

    /**
     * Edita a VARIANTE, endereçada pelo id: `POST /{template_id}` — o caminho da
     * edição é SÓ o id, sem o waba_id (OpenAPI `editar-template`), e não a
     * coleção.
     *
     * Nome e idioma entram aqui só para ACHAR o id: a plataforma não os deixa
     * mudar, porque são eles que identificam a linha.
     */
    async update({ organizationId, sessionRef, name, language, patch }): Promise<ChannelTemplate> {
      const c = await credencial({ organizationId, sessionRef });
      const id = await idDaVariante(c, name, language);
      const editado = await postar(c, `/${encodeURIComponent(id)}`, {
        ...(patch.category ? { category: patch.category } : {}),
        ...(patch.components ? { components: patch.components } : {}),
      });
      // O nó devolve `id/name/category` sem o idioma — ele identifica a variante
      // e não muda —, então ele vem de quem chamou e o escolheu na tela.
      return { ...editado, language };
    },

    /**
     * Apaga UMA variante: o id dela em `hsm_id`, o nome em `name`.
     *
     * Medido na documentação da própria plataforma (Datafy,
     * `api-reference/whatsapp/templates/deletar-template`): sem `hsm_id` o
     * DELETE remove TODOS os idiomas daquele nome; com `hsm_id` "apenas aquela
     * versão é removida, e o `name` continua obrigatório" — por isso os dois
     * viajam juntos. O id é resolvido ANTES: se a variante não está na conta,
     * isto lança e nada é apagado, em vez de cair no nome só (#1734).
     */
    async remove({ organizationId, sessionRef, name, language }): Promise<void> {
      const c = await credencial({ organizationId, sessionRef });
      const id = await idDaVariante(c, name, language);
      const baseDaFonte = base();
      const url = `${baseDaFonte}/${encodeURIComponent(c.wabaId)}/message_templates?name=${encodeURIComponent(name)}&hsm_id=${encodeURIComponent(id)}`;
      const res = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${c.token}` },
      });
      if (!res.ok) throw erroDaGraph(rotulo, res, await lerJson(res), "failed");
    },
  };
}

/**
 * A recusa é "esta conta não pode gerenciar modelo"? — pergunta para a ROTA.
 *
 * A plataforma responde isso de três jeitos, e os três já foram vistos: HTTP 403
 * com `error.code` `200` ("Permissions error", o caso de faltar
 * `whatsapp_business_management`), `code` `10` ("permission denied"), ou 200 no
 * corpo com a MENSAGEM citando o escopo. Sem esta classificação a tela do canal
 * oficial dizia "não deu" (502) para um problema de permissão do app da Meta —
 * que é acionável: quem administra o app precisa dar acesso avançado/escopo.
 *
 * Fica aqui, e não na rota, porque é conhecimento do DIALETO da plataforma — a
 * mesma razão pela qual o cliente de modelo mora neste arquivo.
 */
export function erroDePermissaoDeGestao(err: unknown): boolean {
  if (err instanceof ErroDeModelosDaGraph) {
    if (err.status === 403) return true;
    if (err.codigo === "200" || err.codigo === "10") return true;
  }
  const texto = err instanceof Error ? err.message : "";
  return /whatsapp_business_management|permissions error/i.test(texto);
}

export type { ChannelTemplate, ChannelTemplateDraft };
