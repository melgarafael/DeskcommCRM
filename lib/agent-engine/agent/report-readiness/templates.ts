/**
 * TEXTOS do fluxo de consulta de laudo, em três idiomas (inglês, hindi em
 * devanagari, hinglish em latino). São frases DETERMINÍSTICAS: o motor manda
 * estas frases direto, sem modelo — por isso são factualmente fechadas
 * (pergunta de dado, "precisa de checagem manual") e sem promessa de retorno
 * humano no futuro ("vou te falar depois"), que o guardrail de caso vetaria.
 * Cada pergunta que se repete entre leads tem variantes sorteadas por hash do
 * contato (mesma disciplina do aviso de escalação): o spinning gate conta
 * frases idênticas por NÚMERO e vetaria a terceira pessoa a perguntar a mesma
 * coisa na janela.
 *
 * O que NÃO está aqui de propósito: texto de status verificado, de valor ou de
 * imagem de pagamento. Status VERIFICADO é resposta de integração da instalação (extensão), e o
 * core não afirma status que não pode conferir — o único desfecho que ele
 * conhece é "isto precisa de checagem humana".
 */
import { createHash } from 'node:crypto';

import type { Idioma } from './intent';

/** Variante determinística por contato: sha256(lead) → índice. Mesma regra do aviso de escalação. */
export function variante<T>(leadId: string, opcoes: readonly T[]): T {
  const digest = createHash('sha256').update(leadId).digest();
  return opcoes[digest.readUInt32BE(0) % opcoes.length]!;
}

export interface TextosFluxo {
  /** Pergunta de categoria — 3 variantes por idioma. */
  perguntarCategoria: readonly string[];
  /** A categoria é patologia e o status PRECISA de checagem humana. */
  verificarPelaEquipe: string;
  perguntarBiopsy: Record<'nome' | 'data_cirurgia' | 'medico', string>;
  perguntarRadiologia: Record<'nome' | 'data_exame' | 'exame', string>;
  detalhesAnotados: string;
  naoEntendi: string;
}

const EN: TextosFluxo = {
  perguntarCategoria: [
    'Which service is this report for? 1) Pathology test  2) Biopsy  3) Radiology (Ultrasound, 2D Echo, TMT, ECG)',
    'Which service does this report belong to? 1) Pathology test  2) Biopsy  3) Radiology (Ultrasound, 2D Echo, TMT, ECG)',
    'Please tell me which service this report is for: 1) Pathology test  2) Biopsy  3) Radiology (Ultrasound, 2D Echo, TMT, ECG)',
  ],
  verificarPelaEquipe:
    'Your report status needs a manual check at the lab. I am passing this to a colleague at the front desk now.',
  perguntarBiopsy: {
    nome: 'Patient name, as on the registration?',
    data_cirurgia: 'Date of surgery?',
    medico: "Doctor's name or hospital name?",
  },
  perguntarRadiologia: {
    nome: 'Patient name, as on the record?',
    data_exame: 'Date of the test?',
    exame: 'Which test? (Ultrasound, 2D Echo, TMT or ECG)',
  },
  detalhesAnotados:
    'Thank you. The details are noted and I am passing this to a colleague at the front desk now.',
  naoEntendi:
    'I could not understand that. I am passing this to a colleague at the front desk now.',
};

const HI: TextosFluxo = {
  perguntarCategoria: [
    'यह रिपोर्ट किस सेवा की है? 1) पैथोलॉजी टेस्ट  2) बायोप्सी  3) रेडियोलॉजी (अल्ट्रासाउंड, 2D इको, TMT, ECG)',
    'यह रिपोर्ट किस सर्विस की है? 1) पैथोलॉजी टेस्ट  2) बायोप्सी  3) रेडियोलॉजी (अल्ट्रासाउंड, 2D इको, TMT, ECG)',
    'कृपया बताइए यह रिपोर्ट किस सेवा की है: 1) पैथोलॉजी टेस्ट  2) बायोप्सी  3) रेडियोलॉजी (अल्ट्रासाउंड, 2D इको, TMT, ECG)',
  ],
  verificarPelaEquipe:
    'रिपोर्ट की स्थिति लैब में चेक करनी होगी। मैं यह जानकारी अभी डेस्क के सहयोगी को भेज रहा हूँ।',
  perguntarBiopsy: {
    nome: 'मरीज़ का नाम?',
    data_cirurgia: 'ऑपरेशन की तारीख?',
    medico: 'डॉक्टर का नाम या अस्पताल का नाम?',
  },
  perguntarRadiologia: {
    nome: 'मरीज़ का नाम?',
    data_exame: 'टेस्ट की तारीख?',
    exame: 'कौन-सा टेस्ट? (अल्ट्रासाउंड, 2D इको, TMT या ECG)',
  },
  detalhesAnotados:
    'धन्यवाद। जानकारी नोट कर ली है, मैं इसे अभी डेस्क के सहयोगी को भेज रहा हूँ।',
  naoEntendi:
    'यह समझ नहीं आया। मैं यह अभी डेस्क के सहयोगी को भेज रहा हूँ।',
};

const HINGLISH: TextosFluxo = {
  perguntarCategoria: [
    'Yeh report kis service ki hai? 1) Pathology test  2) Biopsy  3) Radiology (Ultrasound, 2D Echo, TMT, ECG)',
    'Yeh report kis service se related hai? 1) Pathology test  2) Biopsy  3) Radiology (Ultrasound, 2D Echo, TMT, ECG)',
    'Bataiye yeh report kis service ki hai: 1) Pathology test  2) Biopsy  3) Radiology (Ultrasound, 2D Echo, TMT, ECG)',
  ],
  verificarPelaEquipe:
    'Report ka status lab mein manual check karna hoga. Main yeh abhi desk ke colleague ko bhej raha hoon.',
  perguntarBiopsy: {
    nome: 'Patient ka naam?',
    data_cirurgia: 'Operation ki date?',
    medico: 'Doctor ka naam ya hospital ka naam?',
  },
  perguntarRadiologia: {
    nome: 'Patient ka naam?',
    data_exame: 'Test ki date?',
    exame: 'Kaunsa test? (Ultrasound, 2D Echo, TMT ya ECG)',
  },
  detalhesAnotados:
    'Shukriya. Details note kar li hain, main yeh abhi desk ke colleague ko bhej raha hoon.',
  naoEntendi:
    'Yeh samajh nahi aaya. Main yeh abhi desk ke colleague ko bhej raha hoon.',
};

const TEXTOS: Record<Idioma, TextosFluxo> = { en: EN, hi: HI, hinglish: HINGLISH };

export function textosDoFluxo(idioma: Idioma): TextosFluxo {
  return TEXTOS[idioma] ?? EN;
}
