/**
 * Os fusos horários que a tela oferece — e a checagem de que o fuso EXISTE.
 *
 * ─── O defeito, medido ─────────────────────────────────────────────────────
 *
 * O campo do fuso da janela de envio era texto livre, validado só por
 * `z.string().min(1).max(64)`. Qualquer coisa passava. E o motor usa
 * `Intl.DateTimeFormat({ timeZone })`, que LANÇA `RangeError` num fuso que não
 * existe:
 *
 *   America/Asuncion   → 23h        ✓
 *   America/Asunción   → RangeError  ← o acento que um hispanofalante escreve
 *   Asuncion           → RangeError
 *
 * Ou seja: um acento no campo salvava sem reclamar e derrubava a avaliação da
 * janela em TODO envio daquele canal. O defeito não aparece na tela que o
 * causou — aparece no worker, horas depois, como envio que não sai.
 *
 * ─── Duas defesas, e as duas fazem falta ───────────────────────────────────
 *
 * A LISTA impede o erro de digitação, que é a origem real. A CHECAGEM defende a
 * API, que aceita qualquer cliente e não passa pela tela — e defende a lista de
 * si mesma, se alguém acrescentar um código errado aqui.
 */

/**
 * Fusos oferecidos, agrupados pelo que este público usa.
 *
 * Não é a lista IANA inteira (são centenas). Faltar um é um pedido de uma
 * linha; oferecer trezentos faz o operador procurar o dele numa lista que não
 * termina — e a busca é justamente onde ele digita errado.
 */
export const FUSOS_OFERECIDOS: { codigo: string; rotulo: string }[] = [
  { codigo: "America/Asuncion", rotulo: "Assunção (Paraguai)" },
  { codigo: "America/Argentina/Buenos_Aires", rotulo: "Buenos Aires (Argentina)" },
  { codigo: "America/Montevideo", rotulo: "Montevidéu (Uruguai)" },
  { codigo: "America/Santiago", rotulo: "Santiago (Chile)" },
  { codigo: "America/La_Paz", rotulo: "La Paz (Bolívia)" },
  { codigo: "America/Lima", rotulo: "Lima (Peru)" },
  { codigo: "America/Bogota", rotulo: "Bogotá (Colômbia)" },
  { codigo: "America/Mexico_City", rotulo: "Cidade do México (México)" },
  { codigo: "America/Sao_Paulo", rotulo: "São Paulo (Brasil)" },
  { codigo: "America/Manaus", rotulo: "Manaus (Brasil)" },
  { codigo: "America/Belem", rotulo: "Belém (Brasil)" },
  { codigo: "America/Recife", rotulo: "Recife (Brasil)" },
  { codigo: "America/Fortaleza", rotulo: "Fortaleza (Brasil)" },
  // Fora da América do Sul, e de propósito: quem instala em Angola fala
  // português e usava a lista inteira errada. Aditivo — `FUSO_PADRAO` segue
  // `America/Sao_Paulo`, então ninguém que já escolheu muda de relógio.
  { codigo: "Africa/Luanda", rotulo: "Luanda (Angola)" },
  // Mesmo motivo, em Portugal: sem Lisboa, quem opera lá ficava entre um fuso
  // do Brasil e UTC — e UTC erra uma hora no verão europeu.
  { codigo: "Europe/Lisbon", rotulo: "Lisboa (Portugal)" },
  { codigo: "UTC", rotulo: "UTC" },
];

/**
 * O fuso de quem ainda não escolheu — e o mesmo valor das outras duas pontas:
 * o DEFAULT da coluna `organizations.timezone` (baseline.sql) e o
 * `availabilityScheduleSchema` da jornada (`lib/schemas/routing.ts`).
 *
 * Existe para quem precisa DEGRADAR: leitor que encontra a coluna com um valor
 * que o `Intl` recusa não pode lançar nem inventar UTC — UTC daria três horas
 * de erro numa instalação brasileira, calado. Cair no mesmo valor que o banco
 * já usa como padrão mantém uma verdade só.
 *
 * ⚠️ NÃO é o fuso do pacing. `PACING_DEFAULTS.timezone` tem o mesmo texto e
 * responde a outra pergunta (a janela anti-ban daquele CANAL, override por
 * linha em `channel_knobs`). Coincidem hoje; unificar os dois faria uma
 * decisão de anti-ban mudar o relógio do agente.
 */
export const FUSO_PADRAO = "America/Sao_Paulo";

/**
 * O runtime consegue usar este fuso?
 *
 * Pergunta ao `Intl`, e não a uma lista: é o `Intl` que o motor da janela usa, e
 * uma lista nossa responderia "sim" para um código que ele recusa. A base de
 * fusos muda (países criam e apagam zonas), e quem sabe qual versão está
 * instalada é o próprio runtime.
 */
export function fusoValido(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * O primeiro fuso utilizável da lista — e `FUSO_PADRAO` quando nenhum serve.
 *
 * Existe porque quem apresenta hora tem uma ORDEM de fontes, não uma fonte: a
 * escolha da pessoa vem antes da escolha da organização, que vem antes do
 * padrão do produto. Sem isto, cada tela escreve a própria cadeia de `??` e
 * uma delas esquece de validar — e o valor que o `Intl` recusa só aparece como
 * tela branca, porque `Intl.DateTimeFormat` LANÇA com fuso inválido.
 *
 * Nenhum escritor valida `organizations.timezone` nem `user_metadata.timezone`
 * (`tenantSchema` e o schema do onboarding são `z.string().max(64)` sem
 * `refine`, e a coluna não tem CHECK), então "inutilizável" não é hipótese: é
 * o campo de texto que alguém preencheu com acento.
 *
 * Falha ABERTA, como `fusoDaOrganizacao`: uma hora de diferença é melhor que
 * uma tela que não abre.
 */
export function fusoUtilizavel(...candidatos: (string | null | undefined)[]): string {
  for (const bruto of candidatos) {
    const tz = bruto?.trim() ?? "";
    if (tz !== "" && fusoValido(tz)) return tz;
  }
  return FUSO_PADRAO;
}

/**
 * O fuso INICIAL de um formulário que só oferece `FUSOS_OFERECIDOS` (um
 * <select>): o da organização, se estiver entre as opções; senão `FUSO_PADRAO`.
 *
 * `fusoUtilizavel` responde "o runtime aceita?", e isso não basta aqui: um fuso
 * válido que não está na lista (`America/Chihuahua`) não teria <option> no
 * <select>, e a tela mostraria outro fuso enquanto o estado guarda esse. Fora da
 * lista, cai no padrão — o mesmo que o formulário sempre sugeriu.
 */
export function fusoOferecidoOuPadrao(tz: string | null | undefined): string {
  const candidato = tz?.trim() ?? "";
  return FUSOS_OFERECIDOS.some((f) => f.codigo === candidato) ? candidato : FUSO_PADRAO;
}

/**
 * O fuso dito como gente fala, para a tela: "Manaus" de `America/Manaus`,
 * "Buenos Aires" de `America/Argentina/Buenos_Aires`. Fuso sem barra volta como
 * veio (nunca string vazia).
 */
export function cidadeDoFuso(timezone: string): string {
  const ultimo = timezone.split("/").at(-1) ?? timezone;
  return ultimo.replace(/_/g, " ");
}
