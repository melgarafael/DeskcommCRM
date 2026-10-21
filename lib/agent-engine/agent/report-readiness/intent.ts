/**
 * DETECÇÃO DETERMINÍSTICA do fluxo de consulta de laudo/reports. Tudo aqui é
 * PURO e sem modelo: o texto do paciente casando estes padrões engaja o fluxo
 * de serviço (workflow.ts) no lugar de uma resposta genérica de FAQ; nada fora
 * da lista engaja — preços, horários e os demais intents que já funcionam
 * seguem intocados para o modelo.
 *
 * Cobertura de idioma: inglês, hindi (devanagari) e hinglish em alfabeto
 * latino ("report kab milegi?", "mera report mil gaya?", "miltajulta" e
 * parentes). Detecção de serviço: pathology / biopsy / radiology (ultrasound,
 * 2D Echo, TMT, ECG) — os três braços do workflow.
 */

export type Servico = 'pathology' | 'biopsy' | 'radiology';
export type Idioma = 'en' | 'hi' | 'hinglish';

/** Minúsculas + sem diacríticos para casar latino; o devanagari casa no texto original. */
function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * "Laudo/report" em qualquer idioma coberto (inglês, devanagari).
 */
function temLaudo(t: string, original: string): boolean {
  return /report|रिपोर्ट|परिणाम|नतीज/.test(t) || /रिपोर्ट|परिणाम|नतीज/.test(original);
}

/**
 * Pergunta de PRONTO-ATENDIMENTO de laudo: tem "laudo" E marca de prazo/status/
 * entrega; ou a expressão avulsa "miltajulta" (saudação comum de pacientes
 * que perguntam por laudos). Conservador de propósito: "share your
 * report" sem marcador NÃO engaja — o modelo responde como antes.
 */
export function ehPerguntaDeLaudo(texto: string): boolean {
  const t = normalizar(texto);
  if (/\bmiltajulta\b/.test(t) || /मिलताजुलता/.test(texto)) return true;
  if (!temLaudo(t, texto)) return false;
  return (
    /\b(ready|status|available|download|when|where|got|gotcha|received|receive|kab|kahan|mil|mila|mili|milega|milegi|taiyar|tayyar|check|checks|checking|kitni)\b/.test(t) ||
    /कब|तैयार|कहाँ|मिल|स्टेटस|चेक/.test(texto)
  );
}

/**
 * Categoria de serviço citada no texto. Ordem importa: radiologia primeiro
 * (palavras exclusivas), depois biopsy, pathology por último (marcadores mais
 * genéricos como "blood"/"sample"). Sem citação = null (o fluxo pergunta).
 */
export function detectarServico(texto: string): Servico | null {
  const t = normalizar(texto);
  if (
    /\b(ultrasound|sonography|usg|2d echo|2-d echo|echocardiogram|tmt|treadmill|ecg|ekg|radiology|radiologia)\b/.test(t) ||
    /अल्ट्रासाउंड|सोनोग्राफी|रेडियोलॉजी|ईसीजी|एकोकार्डियोग्राफी/.test(texto)
  ) {
    return 'radiology';
  }
  if (/\bbiopsy\b/.test(t) || /बायोप्सी/.test(texto)) return 'biopsy';
  if (
    /\b(pathology|pathological|blood|urine|cbc|haemogram|hemogram|culture|sample)\b/.test(t) ||
    /पैथोलॉजी|रक्त|खून|यूरिन|सैंपल|हिमोग्लोबिन/.test(texto)
  ) {
    return 'pathology';
  }
  return null;
}

/**
 * Resposta do paciente à pergunta de categoria (Case C): dígito 1/2/3 (com ou
 * sem texto em volta) ou o nome da categoria. Reusa `detectarServico` —
 * "Radiology" casa como radiology, "biopsy" como biopsy.
 */
export function respostaDeServico(texto: string): Servico | null {
  const t = normalizar(texto).replace(/[^a-z0-9\s]/g, ' ').trim();
  const digito = t.match(/^\d+$/)?.[0];
  if (digito === '1') return 'pathology';
  if (digito === '2') return 'biopsy';
  if (digito === '3') return 'radiology';
  return detectarServico(texto);
}

/**
 * OUTRA intenção nítida (preço/desconto) no meio do fluxo: o estado é largado e
 * a mensagem segue para o modelo — o pricing que já funciona não pode ser
 * engolido por uma pergunta pendente de laudo.
 */
export function ehOutraIntencao(texto: string): boolean {
  const t = normalizar(texto);
  return (
    /\b(pricing|price|prices|cost|discount|discounts|offer|offers|fee|fees|charge|charges|rate|mrp|how much)\b/.test(t) ||
    /\b(kitna|kitne|ke rate|mahanga|sasta)\b/.test(t) ||
    /कितना|कितने|कीमत|दाम|छूट|मूल्य|रेट/.test(texto)
  );
}

/** Saudação/ack curto: não é valor para campo nenhum — pergunta de novo, nunca grave. */
export function ehPreenchimentoUtil(texto: string): boolean {
  const t = normalizar(texto).trim();
  if (t.length < 2) return false;
  if (t.length < 15 && /^(hi|hello|hey|ok|okay|yes|no|haan|han|ji|namaste|namaskar|thanks|thank you|shukriya|theek|acha|accha|good|fine)\b/.test(t)) {
    return false;
  }
  return t.split(/\s+/).length <= 10;
}

/** Datas em qualquer formato razoável que um paciente digite (EN/numérico/devanagari). */
export function extrairDatas(texto: string): string[] {
  const latim = texto.match(
    /\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}\b/gi,
  );
  const devanagari = texto.match(
    /(\d{1,2}\s*)?(जनवरी|फ़रवरी|फरवरी|मार्च|अप्रैल|मई|जून|जुलाई|अगस्त|सितंबर|अक्टूबर|नवंबर|दिसंबर)/g,
  );
  return [...(latim ?? []), ...(devanagari ?? [])];
}

/** Médico/hospital dito junto: "Dr. Sen", "doctor Sen", "KIMS hospital", "डॉ. शर्मा". */
export function extrairMedico(texto: string): string | null {
  const m =
    texto.match(/\b(?:dr|doctor|hospital|clinic|nursing home)s?\b\.?(?:\s+[A-Za-zÀ-ÿ0-9'.-]+)*/i) ??
    texto.match(/(डॉ\.?|अस्पताल)(\s+[^\s,;.!?।]+)*/);
  return m !== null ? m[0].trim() : null;
}

/** Remove de um texto as partes já consumidas (datas, médico) — sobra o nome/exame. */
function semDatasNemMedico(texto: string): string {
  let limpo = texto;
  for (const d of extrairDatas(limpo)) limpo = limpo.split(d).join(' ');
  const medico = extrairMedico(limpo);
  if (medico !== null) limpo = limpo.split(medico).join(' ');
  return limpo.replace(/\s{2,}/g, ' ').replace(/^[,;:\-\s]+|[,;:\-\s]+$/g, '').trim();
}

export type CampoColetado = 'nome' | 'data_cirurgia' | 'medico' | 'data_exame' | 'exame';

/**
 * Preenche o que o texto de HOJE informa, sem inventar: o campo PERGUNTADO é
 * respondido pelo texto inteiro (caso comum: "Ravi Kumar" para "o nome?"),
 * e data/médico ditos junto já caem nos seus campos — uma mensagem com tudo
 * completa a coleta de uma vez. Data só com data no texto, nunca estimada.
 */
export function coletarDoTexto(
  texto: string,
  servico: Servico,
  atuais: Record<string, string>,
  pendente: CampoColetado | null,
): Record<string, string> {
  const detalhes = { ...atuais };
  const datas = extrairDatas(texto);
  const medicoFrase = extrairMedico(texto);
  const campoData: CampoColetado = servico === 'biopsy' ? 'data_cirurgia' : 'data_exame';
  const primeiraData = datas[0];
  if (detalhes[campoData] === undefined && primeiraData !== undefined) detalhes[campoData] = primeiraData;
  if (servico === 'biopsy' && detalhes.medico === undefined && medicoFrase !== null) {
    detalhes.medico = medicoFrase;
  }
  const resto = semDatasNemMedico(texto)
    .replace(/^(on|at|dated|dtd|dina|tarikh|tareekh|ko|ki|ke)\b\s*/i, '')
    .trim();
  if (pendente === 'medico' && detalhes.medico === undefined && texto.trim().length >= 2) {
    detalhes.medico = (medicoFrase ?? texto).trim();
  } else if (pendente === 'nome' && detalhes.nome === undefined && resto.length >= 2) {
    detalhes.nome = resto;
  } else if (pendente === 'exame' && detalhes.exame === undefined && resto.length >= 2) {
    detalhes.exame = resto;
  }
  return detalhes;
}

/** Ordem de perguntas por serviço (uma por vez, como o fluxo exige). */
export const ORDEM_COLETA: Record<'biopsy' | 'radiology', readonly CampoColetado[]> = {
  biopsy: ['nome', 'data_cirurgia', 'medico'],
  radiology: ['nome', 'data_exame', 'exame'],
};

/** Próximo campo ainda não respondido, ou null quando a coleta completou. */
export function proximoPendente(
  servico: 'biopsy' | 'radiology',
  detalhes: Record<string, string>,
): CampoColetado | null {
  for (const campo of ORDEM_COLETA[servico]) {
    if (detalhes[campo] === undefined) return campo;
  }
  return null;
}

/**
 * Mensagem de REGISTRO prévia no histórico (Case B): a primeira das últimas
 * N mensagens que casar marcador de registro/consulta serve para estabelecer a
 * categoria — biopsy/radiology explícitos valem; sem citação, o registro de
 * laboratório é pathology (é o que a casa faz). Lista chega da mais recente
 * para a mais antiga.
 */
export function servicoDaMensagemDeRegistro(textos: readonly string[]): Servico | null {
  for (const texto of textos) {
    if (!/\b(registration|registered|appointment|booked|booking|token|sample|collected)\b|रजिस्ट्रेशन|अपॉइंटमेंट|सैंपल/i.test(texto)) {
      continue;
    }
    return detectarServico(texto) ?? 'pathology';
  }
  return null;
}

/**
 * Idioma da resposta do fluxo: devanagari → hindi em devanagari; hinglish em
 * latino → hinglish latino (é o que o prompt publicado manda); resto → inglês
 * (mesma regra de fallback do prompt publicado).
 */
export function detectarIdioma(texto: string): Idioma {
  if (/[\u0900-\u097F]/.test(texto)) return 'hi';
  const t = normalizar(texto);
  if (
    /\b(hai|hain|hoon|kya|kab|kaise|karna|kar|hua|hoga|mujhe|mere|mera|meri|aap|tum|nahi|nahin|batao|bata|chahiye|kitna|kitne|jaldi|abhi|lekin|accha|theek|dena|milegi|milega|mila|mili)\b/.test(t)
  ) {
    return 'hinglish';
  }
  return 'en';
}
