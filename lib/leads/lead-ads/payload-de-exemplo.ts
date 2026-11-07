/**
 * O PAYLOAD DOCUMENTADO DA META, EM FORMA DE FIXTURE.
 *
 * ═══ O QUE É "DOCUMENTADO", AQUI ═══
 *
 * O envelope é o de webhook de PÁGINA da Meta — o mesmo de todo webhook
 * assinado com `object: "page"`: `entry[] → changes[] → { field, value }`. O que
 * esta porta lê é `field: "leadgen"` e o `value` com `leadgen_id`, e é assim que
 * a documentação do Lead Ads descreve o aviso ("Lead Ads Retrieval" /
 * "Webhooks for Pages": `changes[].field = "leadgen"`).
 *
 * `value.field_data[]` é a lista de respostas no formato
 * `{ name, values: [...] }` — a MESMA forma que a leitura do lead pela Graph API
 * devolve. Nesta fatia ela chega EMBUTIDA na entrega de propósito: não há
 * credencial real para chamar a Graph API, a prova é por fixture, e o parser é
 * puro para poder ser medido contra este documento. A chamada autenticada é a
 * próxima fatia, e a ausência de `field_data` tem desfecho NOMEADO justamente
 * para que essa transição não seja silenciosa.
 *
 * ═══ POR QUE UM CONSTRUTOR, E NÃO SÓ UM JSON COLADO ═══
 *
 * Porque metade das asserções precisa MEXER em um campo (tirar `field_data`,
 * trocar o telefone, pôr o `entry[].time` no agora para a janela valer), e um
 * JSON copiado e editado à mão em cada teste vira cinco payloads que divergem do
 * documento — e o teste passa a medir o texto errado. O literal abaixo é o
 * exemplo canônico (e é ele que `payload.test.ts` lê primeiro, sem construtor
 * nenhum); o construtor é a mesma forma com overrides.
 */

export interface RespostasDoExemplo {
  nome: string;
  telefone: string;
  email: string;
  /** As perguntas do formulário, além das três de identidade. */
  extras: Array<{ name: string; values: string[] }>;
}

const RESPOSTAS_DO_EXEMPLO: RespostasDoExemplo = {
  nome: "Maria Aparecida Souza",
  telefone: "(11) 98888-7777",
  email: "maria.souza@exemplo.com.br",
  extras: [
    { name: "qual_o_seu_objetivo", values: ["Comprar nos próximos 30 dias"] },
    { name: "cidade", values: ["São Paulo"] },
  ],
};

/**
 * O exemplo canônico, verbatim — o "payload documentado" que o teste do parser
 * lê sem nenhuma ajuda do construtor.
 *
 * `entry[].time` é fixo (2026-10-31T12:00:00Z) porque este literal serve à
 * LEITURA; quem exercita a janela da porta usa `entregaDoLeadAds({ entradaEm })`
 * com o instante do teste.
 */
export const PAYLOAD_DOCUMENTADO_DA_META = `{
  "object": "page",
  "entry": [
    {
      "id": "102938475657483",
      "time": 1793448000,
      "changes": [
        {
          "field": "leadgen",
          "value": {
            "ad_id": "52566549792345",
            "adgroup_id": "52566549792346",
            "campaign_id": "52566549792347",
            "created_time": 1793447940,
            "form_id": "1187654321098765",
            "leadgen_id": "9988776655443322",
            "page_id": "102938475657483",
            "field_data": [
              { "name": "full_name", "values": ["Maria Aparecida Souza"] },
              { "name": "phone_number", "values": ["(11) 98888-7777"] },
              { "name": "email", "values": ["maria.souza@exemplo.com.br"] },
              { "name": "qual_o_seu_objetivo", "values": ["Comprar nos próximos 30 dias"] },
              { "name": "cidade", "values": ["São Paulo"] }
            ]
          }
        }
      ]
    }
  ]
}`;

export interface OpcoesDaEntrega {
  leadgenId?: string;
  /** `entry[].time`, em segundos. Fixo por padrão: quem testa a janela escolhe. */
  entradaEm?: number;
  /** `false` = o aviso SEM as respostas (a forma do webhook cru da Meta). */
  comRespostas?: boolean;
  nome?: string;
  telefone?: string;
  email?: string;
  /** `false` remove o `leadgen_id` — o caso do value fora do contrato. */
  comLeadgenId?: boolean;
  extras?: Array<{ name: string; values: string[] }>;
}

/**
 * Uma entrega de UMA página com UM lead. Os defaults são o exemplo canônico;
 * cada opção troca só o que o caso mede.
 */
export function entregaDoLeadAds(opcoes: OpcoesDaEntrega = {}): string {
  const respostas = opcoes.comRespostas === false ? [] : respostasPadrao(opcoes);
  const valor: Record<string, unknown> = {
    ad_id: "52566549792345",
    adgroup_id: "52566549792346",
    campaign_id: "52566549792347",
    created_time: (opcoes.entradaEm ?? 1793448000) - 60,
    form_id: "1187654321098765",
    page_id: "102938475657483",
    ...(opcoes.comLeadgenId === false
      ? {}
      : { leadgen_id: opcoes.leadgenId ?? "9988776655443322" }),
    ...(opcoes.comRespostas === false ? {} : { field_data: respostas }),
  };
  return JSON.stringify({
    object: "page",
    entry: [
      {
        id: "102938475657483",
        time: opcoes.entradaEm ?? 1793448000,
        changes: [{ field: "leadgen", value: valor }],
      },
    ],
  });
}

function respostasPadrao(opcoes: OpcoesDaEntrega): Array<{ name: string; values: string[] }> {
  return [
    { name: "full_name", values: [opcoes.nome ?? RESPOSTAS_DO_EXEMPLO.nome] },
    { name: "phone_number", values: [opcoes.telefone ?? RESPOSTAS_DO_EXEMPLO.telefone] },
    { name: "email", values: [opcoes.email ?? RESPOSTAS_DO_EXEMPLO.email] },
    ...(opcoes.extras ?? RESPOSTAS_DO_EXEMPLO.extras),
  ];
}

/** O que o exemplo promete, para os testes não repetirem literais soltos. */
export const ESPERADO_DO_EXEMPLO = {
  leadgenId: "9988776655443322",
  formId: "1187654321098765",
  pageId: "102938475657483",
  adId: "52566549792345",
  campaignId: "52566549792347",
  nome: RESPOSTAS_DO_EXEMPLO.nome,
  /** O mesmo número em E.164 canônico (celular BR com o nono dígito). */
  telefone: "+5511988887777",
  email: RESPOSTAS_DO_EXEMPLO.email,
} as const;
