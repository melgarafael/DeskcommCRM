/**
 * Os MODELOS DE MENSAGEM — as respostas prontas que a empresa já escreveu
 * (`message_templates`).
 *
 * ⚠️ PREENCHER NÃO É ENVIAR, e a separação é o ponto. Enviar é
 * `crm_send_whatsapp_message`, classificada `critico` porque o cliente recebe de
 * verdade no celular dele. Preencher só devolve TEXTO: quem lê decide o que
 * fazer com ele. Juntar as duas coisas numa capacidade só faria "usar o modelo
 * de boas-vindas" carregar, escondido, o direito de falar com o cliente.
 *
 * ⚠️ O MODELO É DA EMPRESA, O AGENTE NÃO ESCREVE UM NOVO. Um modelo é texto
 * revisado por gente para sair em nome da marca; deixar o agente criar modelo
 * seria deixá-lo publicar a própria voz como se fosse a da empresa, e nenhuma
 * tela hoje distingue um do outro. Escrever mensagem o agente já sabe — o que
 * ele ganha aqui é PARAR de inventar quando a empresa já decidiu como diz.
 *
 * ⚠️ A LISTA NÃO TRAZ O PESSOAL DE TODO MUNDO, e a régua NÃO foi inventada
 * aqui: é a policy `message_templates_select` (migration 0060) — um membro lê o
 * compartilhado (`owner_user_id is null`) **mais o próprio**. A tela e a rota
 * REST herdam esse predicado da RLS de graça; a tool usa o client **service
 * role**, que bypassa a policy, e por isso listava os rascunhos pessoais de cada
 * atendente para qualquer token de integração. O `eq("organization_id", …)` não
 * bastava: ele separa empresas, e o vazamento era dentro da mesma empresa.
 *
 * ⚠️ AS VARIÁVEIS DO INTEGRADOR SÃO VALIDADAS, e a validação RECUSA em vez de
 * ignorar. `valores` existe para o que só quem chama sabe — o link do formulário,
 * o valor em aberto —, nunca para o que o CRM já tem no contato. Uma chave que o
 * corpo não usa, ou que o contato/negócio preenche, é descartada em silêncio por
 * um render que só troca marcação: quem chamou receberia "Olá , tudo bem?" com
 * `lacunas` vazio e um `success`. Recusar com o nome da variável é a única
 * resposta que faz quem chamou consertar o pedido.
 */
import { ApiError } from "@/lib/api/types";
import { marcacaoDoCrm, renderTemplate } from "@/lib/automation/template";
import type { DepsDaOperacao } from "@/lib/operacao/entradas-automaticas";

/** A varredura de marcação, a MESMA do render (`lib/automation/template.ts`). */
const MARCACAO = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Teto do nome de uma variável do integrador. Curto de propósito: é identificador. */
export const CHAVE_DE_VALOR_MAX = 40;
/** Teto de UM valor. Link e número cabem folgados; despejo de texto não. */
export const VALOR_DE_VARIAVEL_MAX = 2000;
/** Teto de variáveis numa chamada — o corpo do modelo é que manda no resto. */
export const VALORES_MAX = 40;

/** `[a-z_]+`: minúscula e sublinhado, como o resto do vocabulário de marcação. */
const CHAVE_DE_VALOR = /^[a-z_]+$/;

export interface ModeloVisivel {
  id: string;
  titulo: string;
  corpo: string;
  atalho: string | null;
  /** `true` = da empresa inteira; `false` = pessoal de quem o criou. */
  compartilhado: boolean;
  /**
   * As marcações que o corpo usa, na ordem em que aparecem e sem repetição.
   *
   * ⚠️ SEM ISTO, QUEM CHAMA SÓ DESCOBRE A MARCAÇÃO DEPOIS DE ERRAR. Um sistema
   * externo que quer montar o texto precisa saber que este modelo pede
   * `{{link_formulario}}` — e a alternativa era tentar um `valores` no chute,
   * colher a recusa e tentar de novo.
   */
  variaveis: string[];
}

export interface OpcoesDosModelos {
  /** O pessoal só entra com isto ligado **e** com um dono de verdade (ver `listarModelosDeMensagem`). */
  incluirPessoais?: boolean;
}

export async function listarModelosDeMensagem(
  deps: DepsDaOperacao,
  opts: OpcoesDosModelos = {},
): Promise<ModeloVisivel[]> {
  // O dono que pode aparecer na lista: `null` quando quem age não é uma pessoa.
  // `actor.id` de um token é o id do TOKEN (ou o do run do agente) e nunca casa
  // com um `owner_user_id` — pedir `incluir_pessoais` com um token devolve só os
  // compartilhados, que é o certo: um token não tem rascunho pessoal.
  const dono = deps.actor.type === "user" ? deps.actor.id : null;
  const incluirPessoais = opts.incluirPessoais === true && dono !== null;

  const consulta = visivelPara(
    deps.supabase
      .from("message_templates")
      .select("id, title, body, shortcut, owner_user_id")
      .eq("organization_id", deps.organizationId),
    incluirPessoais ? dono : null,
  );

  const { data, error } = await consulta.order("updated_at", { ascending: false });
  if (error) throw new ApiError(500, "internal_error", undefined, deps.requestId, error.message);

  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((t) => {
    const corpo = t.body as string;
    return {
      id: t.id as string,
      titulo: t.title as string,
      corpo,
      atalho: (t.shortcut as string | null) ?? null,
      compartilhado: t.owner_user_id === null,
      variaveis: variaveisDoCorpo(corpo),
    };
  });
}

/**
 * A régua da policy `message_templates_select`, em SQL e não em memória: o
 * compartilhado sempre, o pessoal só do `dono` (e nenhum quando `dono` é null).
 * Ler a linha pessoal de outra pessoa para descartá-la depois deixaria o
 * vazamento a uma edição de distância — o corpo do modelo é dado, não metadado.
 */
function visivelPara<C extends { or(filtro: string): C; is(coluna: string, valor: null): C }>(
  consulta: C,
  dono: string | null,
): C {
  return dono === null
    ? consulta.is("owner_user_id", null)
    : consulta.or(`owner_user_id.is.null,owner_user_id.eq.${dono}`);
}

export interface ModeloPreenchido {
  id: string;
  titulo: string;
  texto: string;
  /** As marcações que ficaram sem valor — quem lê precisa saber antes de mandar. */
  lacunas: string[];
}

export interface PedidoDePreenchimento {
  templateId: string;
  contactId?: string;
  leadId?: string;
  /**
   * As marcações que só o integrador sabe — `{ link_formulario: "https://…" }`.
   * Chaves em `[a-z_]+`; o que não vier continua listado em `lacunas`.
   */
  valores?: Record<string, string>;
}

/**
 * O modelo com os dados do cliente no lugar das marcações.
 *
 * ⚠️ AS LACUNAS SÃO DEVOLVIDAS, NÃO ESCONDIDAS. `renderTemplate` troca marcação
 * sem valor por string vazia, o que produz "Olá , tudo bem?" — uma frase que
 * parece pronta e sai errada. Dizer QUAIS ficaram vazias é o que permite a quem
 * lê decidir entre completar, escolher outro modelo, ou escrever à mão. Uma
 * função que só devolvesse o texto empurraria esse defeito para o cliente final.
 */
export async function preencherModeloDeMensagem(
  deps: DepsDaOperacao,
  input: PedidoDePreenchimento,
): Promise<ModeloPreenchido> {
  // A MESMA régua da lista: sem ela, um id de modelo pessoal alheio (os que a
  // lista devolvia antes, por exemplo) abria o corpo pelo preenchimento. Fora da
  // régua cai no 404 abaixo, que não diz se o modelo existe.
  const { data: modelo, error } = await visivelPara(
    deps.supabase
      .from("message_templates")
      .select("id, title, body")
      .eq("id", input.templateId)
      .eq("organization_id", deps.organizationId),
    deps.actor.type === "user" ? deps.actor.id : null,
  ).maybeSingle();
  if (error) throw new ApiError(500, "internal_error", undefined, deps.requestId, error.message);
  if (!modelo) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      deps.requestId,
      "Essa resposta pronta não existe aqui.",
    );
  }

  const contexto = await montarContexto(deps, input);
  const corpo = (modelo as unknown as { body: string }).body;
  // Depois do contexto de propósito: a recusa compara `valores` com o CORPO do
  // modelo, e o corpo só existe depois da leitura.
  Object.assign(contexto, valoresDoIntegrador(deps, corpo, input.valores));

  return {
    id: (modelo as unknown as { id: string }).id,
    titulo: (modelo as unknown as { title: string }).title,
    texto: renderTemplate(corpo, contexto),
    lacunas: lacunasDe(corpo, contexto),
  };
}

/**
 * O que da requisição entra no contexto do render — e a recusa do que não entra.
 *
 * As três classes de recusa, todas com o nome da variável:
 *
 * 1. **fora do formato** — `[a-z_]+`, até `CHAVE_DE_VALOR_MAX`;
 * 2. **é do contato/negócio** — `{{nome}}` e `{{contact.*}}`/`{{lead.*}}` têm um
 *    dono no CRM, e aceitar um valor aqui seria escrever por cima dele;
 * 3. **o corpo não usa** — quase sempre um apelido trocado (`link_form` por
 *    `link_formulario`), e o defeito só apareceria no texto final.
 *
 * As três viram UMA recusa: quem chamou conserta o pedido numa rodada, e a
 * mensagem diz quais variáveis o modelo realmente usa.
 */
function valoresDoIntegrador(
  deps: DepsDaOperacao,
  corpo: string,
  valores: Record<string, string> | undefined,
): Record<string, string> {
  const chaves = Object.keys(valores ?? {});
  if (chaves.length === 0) return {};

  const aceitas = new Set(variaveisDoCorpo(corpo));
  const problemas: string[] = [];

  if (chaves.length > VALORES_MAX) {
    problemas.push(`vieram ${chaves.length} variáveis e o teto é ${VALORES_MAX}`);
  }

  for (const chave of chaves) {
    const valor = valores?.[chave];
    if (!CHAVE_DE_VALOR.test(chave) || chave.length > CHAVE_DE_VALOR_MAX) {
      problemas.push(
        `"${chave}" não serve como nome de variável (use letras minúsculas e _, até ${CHAVE_DE_VALOR_MAX} caracteres)`,
      );
      continue;
    }
    if (typeof valor !== "string" || valor.length > VALOR_DE_VARIAVEL_MAX) {
      problemas.push(
        `o valor de "${chave}" precisa ser texto de até ${VALOR_DE_VARIAVEL_MAX} caracteres`,
      );
      continue;
    }
    if (marcacaoDoCrm(chave)) {
      problemas.push(
        `"${chave}" sai do contato ou do negócio — mande contact_id (ou lead_id) em vez de preenchê-la`,
      );
      continue;
    }
    if (!aceitas.has(chave)) {
      problemas.push(
        aceitas.size === 0
          ? `este modelo não usa nenhuma variável, então "${chave}" não tem onde entrar`
          : `"${chave}" não é variável deste modelo (ele usa: ${[...aceitas].join(", ")})`,
      );
      continue;
    }
  }

  if (problemas.length > 0) {
    throw new ApiError(
      422,
      "unprocessable_entity",
      undefined,
      deps.requestId,
      `Não deu para preencher com o que veio em valores: ${problemas.join("; ")}.`,
    );
  }
  return { ...valores };
}

/**
 * O contexto do preenchimento: o contato e o negócio, nada além.
 *
 * O `contact_id` do negócio é usado quando só o negócio foi informado — quem
 * pede "preencha para este negócio" espera o nome do cliente dele, não uma
 * lacuna.
 */
async function montarContexto(
  deps: DepsDaOperacao,
  input: { contactId?: string; leadId?: string },
): Promise<Record<string, unknown>> {
  const contexto: Record<string, unknown> = {};

  let contactId = input.contactId ?? null;

  if (input.leadId) {
    const { data: lead } = await deps.supabase
      .from("crm_leads")
      .select("id, title, value_cents, currency, contact_id")
      .eq("id", input.leadId)
      .eq("organization_id", deps.organizationId)
      .maybeSingle();
    if (lead) {
      contexto.lead = lead;
      contactId = contactId ?? ((lead as unknown as { contact_id: string | null }).contact_id ?? null);
    }
  }

  if (contactId) {
    const { data: contato } = await deps.supabase
      .from("contacts")
      .select("id, name, phone_number, email")
      .eq("id", contactId)
      .eq("organization_id", deps.organizationId)
      .maybeSingle();
    if (contato) contexto.contact = contato;
  }

  return contexto;
}

/** As marcações do corpo, sem repetição e na ordem em que aparecem. */
function variaveisDoCorpo(corpo: string): string[] {
  return [...new Set([...corpo.matchAll(MARCACAO)].map((m) => m[1]!))];
}

/** As marcações do modelo que o contexto não resolveu — mesma varredura do render. */
function lacunasDe(template: string, contexto: Record<string, unknown>): string[] {
  const vazias = new Set<string>();
  for (const m of template.matchAll(MARCACAO)) {
    const marcacao = m[1]!;
    // Comparar o render de UMA marcação isolada é o que garante a mesma régua
    // do texto final: alias, caminho aninhado e ausência passam pelo mesmo código.
    if (renderTemplate(`{{${marcacao}}}`, contexto) === "") vazias.add(marcacao);
  }
  return [...vazias];
}
