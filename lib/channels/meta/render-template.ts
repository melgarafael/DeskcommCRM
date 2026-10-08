/**
 * Renderiza o texto que o LEAD vai ler — os componentes de texto do template com os
 * `{{n}}` já substituídos pelos valores.
 *
 * Existe por causa de uma consequência boa do desenho da cadeia: `runBeforeSend`
 * recebe `body: string` e o entrega aos gates de promessa, spinning e disclosure.
 * Passando o template RENDERIZADO como `body`, esses gates avaliam **exatamente o
 * que o contato vai ler** — em vez de o template ser um ponto cego onde a IA poderia
 * prometer o que a tabela de promessas proíbe.
 *
 * Sem isto, "usar template" viraria a forma de escapar dos guardrails de conteúdo.
 *
 * ─── Uma função só para o texto, e a prévia é filha dela ─────────────────────
 *
 * A #2446 pede que a prévia da janela fechada mostre a mensagem INTEIRA enquanto
 * o atendente digita, com uma exigência que decide o desenho: prévia e mensagem
 * enviada não podem divergir. Duas rotinas de substituição — uma aqui, outra na
 * tela — cumpririam o pedido e reabririam o buraco que a derivação de contrato
 * fechou: o mesmo fato declarado em dois lugares.
 *
 * Por isso a prévia (`renderTemplatePreview`) e este texto (`renderTemplateBody`)
 * saem do MESMO núcleo: o mapa de valores por `slotKey` e a troca do `{{n}}`.
 * `renderTemplateBody` é a projeção CABEÇALHO+CORPO da prévia — o que os gates
 * avaliam é literalmente um pedaço do que a tela mostra.
 */
import { slotKey } from "./build-components";
import {
  deriveTemplateContract,
  type LeafAddress,
  type ParamSlot,
  type SlotAddress,
  type TemplateContract,
} from "./template-contract";

interface ComponenteTexto {
  type?: string;
  text?: string;
  url?: string;
  phone_number?: string;
  buttons?: ComponenteTexto[];
  cards?: { components?: unknown[] }[];
}

/** O que a prévia mostra de UM bloco — o de cima ou o de um card de carrossel. */
export interface BlocoDaPrevia {
  /** HEADER de texto com os valores aplicados. `null` quando não há cabeçalho de texto. */
  cabecalho: string | null;
  /**
   * HEADER de mídia. `formato` é o `expects` do slot (`image` | `video` |
   * `document`) e `link` é o valor do campo — `null` enquanto ele estiver vazio,
   * que é quando a tela tem de dizer "falta o link" em vez de desenhar um
   * retângulo de imagem quebrada.
   */
  midia: { formato: string; link: string | null } | null;
  /** BODY com os valores aplicados. Vazio quando o modelo não tem corpo. */
  corpo: string;
  /** Botões na ordem da definição; `url` já com o sufixo `{{n}}` substituído. */
  botoes: { tipo: string; texto: string; url: string | null; telefone: string | null }[];
}

/** A mensagem INTEIRA, que é o que a prévia da janela fechada promete mostrar. */
export interface PreviaDaMensagem extends BlocoDaPrevia {
  /**
   * FOOTER. Nunca carrega parâmetro (a plataforma não aceita) e mesmo assim entra
   * aqui: mostrar só corpo e cabeçalho seria a prévia de OUTRA mensagem — rodapé
   * e botão são o que o cliente vê e o atendente confere antes de enviar.
   */
  rodape: string | null;
  /** Cada card de um carrossel, com os seus próprios quatro pedaços. */
  cards: (BlocoDaPrevia & { indice: number })[];
}

/** O pedaço do template do qual se quer o endereço dos seus slots. */
type AlvoDoPedaco = { kind: "header" } | { kind: "body" } | { kind: "button"; index: number };

/**
 * Mapa `slotKey` → valor, só com valor PREENCHIDO.
 *
 * Em branco conta como ausente — a MESMA régua de `missingSlots`, que trata valor
 * de espaço em branco como falta. Apagar o `{{n}}` da prévia seria esconder
 * justamente o que falta preencher, e o envio sairia recusado do mesmo jeito.
 */
function mapaDeValores(
  contrato: TemplateContract,
  values: Record<string, string>,
): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const s of contrato.slots) {
    const chave = slotKey(s.address, s.key);
    const valor = values[chave];
    if (valor !== undefined && valor.trim() !== "") mapa.set(chave, valor);
  }
  return mapa;
}

/** O slot de UM pedaço, lido do contrato — `null` quando o pedaço não tem parâmetro. */
function folhaDe(s: ParamSlot, cardIndex: number | null): LeafAddress | null {
  if (s.address.kind === "card") {
    return cardIndex !== null && s.address.cardIndex === cardIndex ? s.address.inner : null;
  }
  return cardIndex === null ? s.address : null;
}

/**
 * O endereço dos slots de um pedaço, TIRADO DO CONTRATO.
 *
 * Não se monta endereço aqui: `deriveTemplateContract` é quem sabe onde cada
 * parâmetro mora, e remontar o endereço a partir do texto seria uma segunda
 * declaração do mesmo fato — o defeito que a derivação existe para eliminar.
 * `null` quando o pedaço não tem parâmetro, e aí não há o que substituir.
 *
 * O endereço é o que separa o `{{1}}` do cabeçalho do `{{1}}` do corpo: os dois
 * cabem no mesmo modelo, com a mesma `key` e valores diferentes.
 */
function enderecoDo(
  slots: ParamSlot[],
  alvo: AlvoDoPedaco,
  cardIndex: number | null,
): SlotAddress | null {
  const achado = slots.find((s) => {
    const folha = folhaDe(s, cardIndex);
    if (!folha || folha.kind !== alvo.kind) return false;
    if (alvo.kind === "button") return folha.kind === "button" && folha.index === alvo.index;
    return true;
  });
  return achado ? achado.address : null;
}

/** Troca cada `{{n}}` pelo valor do SEU endereço. Sem endereço, o texto é dado cru. */
function preencher(texto: string, endereco: SlotAddress | null, mapa: Map<string, string>): string {
  if (!endereco) return texto;
  return texto.replace(
    /\{\{(\w+)\}\}/g,
    (inteiro, chave: string) => mapa.get(slotKey(endereco, chave)) ?? inteiro,
  );
}

/** Lê HEADER, BODY e BUTTONS de UM nível — o de cima ou o de um card. */
function lerBloco(
  lista: ComponenteTexto[],
  slots: ParamSlot[],
  mapa: Map<string, string>,
  cardIndex: number | null,
): BlocoDaPrevia {
  const bloco: BlocoDaPrevia = { cabecalho: null, midia: null, corpo: "", botoes: [] };

  for (const c of lista) {
    const tipo = String(c.type ?? "").toUpperCase();

    if (tipo === "HEADER") {
      if (typeof c.text === "string" && c.text.length > 0) {
        bloco.cabecalho = preencher(c.text, enderecoDo(slots, { kind: "header" }, cardIndex), mapa);
      }
      // Mídia é slot pelo FORMATO, não por placeholder — por isso se procura o
      // slot e não um `{{n}}` no texto: cabeçalho IMAGE não tem nada a contar.
      const slotDeMidia = slots.find((s) => {
        const folha = folhaDe(s, cardIndex);
        return folha?.kind === "header" && s.expects !== "text";
      });
      if (slotDeMidia) {
        bloco.midia = {
          formato: slotDeMidia.expects,
          link: mapa.get(slotKey(slotDeMidia.address, slotDeMidia.key)) ?? null,
        };
      }
    } else if (tipo === "BODY") {
      if (typeof c.text === "string" && c.text.length > 0) {
        bloco.corpo = preencher(c.text, enderecoDo(slots, { kind: "body" }, cardIndex), mapa);
      }
    } else if (tipo === "BUTTONS") {
      (c.buttons ?? []).forEach((b, index) => {
        const fim = enderecoDo(slots, { kind: "button", index }, cardIndex);
        bloco.botoes.push({
          tipo: String(b.type ?? "").toUpperCase(),
          texto: typeof b.text === "string" ? preencher(b.text, fim, mapa) : "",
          url: typeof b.url === "string" && b.url.length > 0 ? preencher(b.url, fim, mapa) : null,
          telefone:
            typeof b.phone_number === "string" && b.phone_number.length > 0
              ? b.phone_number
              : null,
        });
      });
    }
  }

  return bloco;
}

/**
 * A mensagem COMPLETA com os valores aplicados — a prévia que a tela mostra.
 *
 * Mesmo contrato, mesma leitura de endereço e mesmo mapa de valores do texto do
 * envio; a única diferença é que aqui os pedaços ficam separados (cabeçalho,
 * corpo, rodapé, botões), porque é assim que a tela os desenha.
 */
export function renderTemplatePreview(
  components: unknown,
  values: Record<string, string>,
  meta: { name: string; language: string; parameterFormat?: string },
): PreviaDaMensagem {
  const contrato = deriveTemplateContract({
    name: meta.name,
    language: meta.language,
    ...(meta.parameterFormat !== undefined ? { parameter_format: meta.parameterFormat } : {}),
    components: components as never,
  });

  const mapa = mapaDeValores(contrato, values);
  const lista = Array.isArray(components) ? (components as ComponenteTexto[]) : [];

  const bloco = lerBloco(lista, contrato.slots, mapa, null);
  let rodape: string | null = null;
  const cards: (BlocoDaPrevia & { indice: number })[] = [];

  for (const c of lista) {
    const tipo = String(c.type ?? "").toUpperCase();
    if (tipo === "FOOTER") {
      rodape = typeof c.text === "string" && c.text.length > 0 ? c.text : null;
    } else if (tipo === "CAROUSEL") {
      (c.cards ?? []).forEach((card, indice) => {
        const filhos = Array.isArray(card?.components)
          ? (card.components as ComponenteTexto[])
          : [];
        cards.push({ indice, ...lerBloco(filhos, contrato.slots, mapa, indice) });
      });
    }
  }

  return { ...bloco, rodape, cards };
}

/**
 * Junta os textos de HEADER e BODY (nessa ordem) com os valores aplicados.
 *
 * FOOTER fica de fora: é rodapé fixo da marca, nunca carrega parâmetro, e incluí-lo
 * poluiria a análise dos gates com texto que não é da conversa.
 *
 * Hoje é a projeção de `renderTemplatePreview`: o texto do envio é UM pedaço do
 * que a prévia mostra, e as duas saem do mesmo núcleo — prévia e mensagem enviada
 * não têm como divergir.
 */
export function renderTemplateBody(
  components: unknown,
  values: Record<string, string>,
  meta: { name: string; language: string; parameterFormat?: string },
): string {
  const previa = renderTemplatePreview(components, values, meta);
  return [previa.cabecalho, previa.corpo]
    .filter((parte): parte is string => typeof parte === "string" && parte.length > 0)
    .join("\n\n");
}
