/**
 * O detector de afirmação clínica — os dois sentidos, nos DOIS idiomas.
 *
 * Os casos de BARRA são as frases que a operação de uma clínica de dermatologia já
 * viu o modelo tentar (português e espanhol). Os de PASSA são a rotina da recepção e
 * as frases normais de outros nichos que usam as mesmas palavras ("você tem", "use",
 * "garanto") — é onde um detector ingênuo vira ruído e a organização desliga a
 * proteção. O bloco em espanhol é o corpus de controle da clínica hispanofalante:
 * pergunta condicional, rotina da recepção e as frases negadas de preparo.
 */
import { describe, expect, it } from 'vitest';

import { detectarAfirmacaoClinica, renderVetoDeAfirmacaoClinica } from './afirmacao-clinica';

const barra: Array<[string, string]> = [
  ['diagnostico', 'Pelo que você descreveu, você tem uma micose de unha.'],
  ['diagnostico', 'Vc está com dermatite, é bem comum.'],
  ['diagnostico', 'Seu diagnóstico é psoríase leve.'],
  ['diagnostico', 'Essa mancha é um melasma.'],
  ['prescricao', 'Pode passar uma pomada de corticoide duas vezes ao dia.'],
  ['prescricao', 'Tome o antibiótico até a consulta.'],
  ['prescricao', 'O ideal é 500 mg por dia.'],
  ['prescricao', 'Vou te receitar um creme.'],
  ['promessa_de_resultado', 'O tratamento tem cura garantida.'],
  ['promessa_de_resultado', 'Garanto que vai sumir em duas semanas.'],
  ['promessa_de_resultado', 'É 100% de eficácia.'],
  ['afirmacao_oncologica', 'Pela foto, parece ser um melanoma.'],
  ['afirmacao_oncologica', 'Fique tranquila, não é câncer.'],
  ['afirmacao_oncologica', 'Isso tem cara de carcinoma.'],
  // o "se você" da pergunta condicional não pode desarmar o diagnóstico que vem junto
  ['diagnostico', 'Se você tem coceira, você tem uma micose.'],
  ['diagnostico', 'Você tem uma micose, se você tiver dúvida me chame.'],
  ['afirmacao_oncologica', 'Se você está com dúvida: isso é um melanoma.'],
  // dose líquida com o verbo continua sendo prescrição
  ['prescricao', 'Tome 5 ml do xarope de 8 em 8 horas.'],
  // ─── Espanhol: a clínica hispanofalante liga a MESMA proteção ────────────────
  ['diagnostico', 'Según lo que describes, tienes hongos en la uña.'],
  ['diagnostico', 'Usted tiene dermatitis, es muy común.'],
  ['diagnostico', 'Su diagnóstico es psoriasis leve.'],
  ['diagnostico', 'Esa mancha es un melasma.'],
  ['diagnostico', 'Estás con una infección en la piel.'],
  ['diagnostico', 'Presenta una infección en la zona.'],
  // a pergunta condicional em espanhol não pode desarmar o diagnóstico que vem junto
  ['diagnostico', 'Si tienes picazón, tienes hongos.'],
  // "que" não é "si": a guarda condicional não alcança a opinião do agente
  ['diagnostico', 'Creo que tiene hongos.'],
  ['prescricao', 'Puede aplicar una pomada de corticoide dos veces al día.'],
  ['prescricao', 'Tome el antibiótico hasta la consulta.'],
  ['prescricao', 'Lo ideal es 500 mg al día.'],
  ['prescricao', 'Voy a recetarte una crema.'],
  ['prescricao', 'Aplíquese la crema en la zona.'],
  ['prescricao', 'Puede ponerse una pomada en la lesión.'],
  ['promessa_de_resultado', 'El tratamiento tiene cura garantizada.'],
  ['promessa_de_resultado', 'Garantizo que va a desaparecer en dos semanas.'],
  ['promessa_de_resultado', 'Es 100 % de eficacia.'],
  ['afirmacao_oncologica', 'Por la foto, parece ser un melanoma.'],
  ['afirmacao_oncologica', 'Tranquila, no es cáncer.'],
  ['afirmacao_oncologica', 'Eso tiene cara de carcinoma.'],
  ['afirmacao_oncologica', 'Se trata de un melanoma.'],
  // a locução negada não abre brecha para a ordem de NÃO parar o remédio
  ['prescricao', 'Você não pode deixar de tomar o antibiótico.'],
  ['prescricao', 'Usted no puede dejar de usar la crema.'],
];

const passa: string[] = [
  // rotina da recepção
  'Você tem preferência de dia ou horário?',
  'Você tem algum exame recente?',
  'Você tem psoríase há quanto tempo?',
  'Para definir a conduta, precisa de uma consulta com o dermatologista.',
  'A biópsia é o exame que confirma se é câncer.',
  'Se for câncer de pele, o Dr. Diego faz a cirurgia de Mohs.',
  'Caso seja melanoma, a equipe prioriza o seu atendimento.',
  'A consulta custa R$ 450.',
  'Tome nota do endereço: Rua Santa Clara, 50.',
  'Pode usar o estacionamento do prédio.',
  'Passe na recepção 15 minutos antes.',
  'Se você tem alergia a algum medicamento, avise a recepção.',
  'No dia do laser, não passe creme nem maquiagem.',
  'Não use pomada na região antes do procedimento.',
  'Beba 500 ml de água antes do exame.',
  'Obrigada por mandar a foto. Ela ajuda na triagem, mas o diagnóstico é feito em consulta.',
  // outros nichos com as mesmas palavras
  'Você tem 10% de desconto na primeira compra.',
  'Use o cupom BEMVINDO no carrinho.',
  'Garanto a entrega até sexta.',
  'O sérum de 30 ml sai por R$ 120.',
  'O frasco de 200 ml do shampoo custa R$ 89.',
  'O kit vem com 3 g de amostra.',
  // ─── Instrução NEGADA com locução verbal: o lookbehind cobre "não pode" ──────
  // "Não pode passar creme" é preparo de procedimento; a locução nega o verbo, e
  // antes disto o `não` colado só no infinitivo não a alcançava (#2322).
  'Não pode passar creme no dia do laser.',
  'Não pode usar pomada na região antes do procedimento.',
  // ─── Corpus de controle em espanhol: a rotina que NÃO pode ser barrada ───────
  '¿Tiene preferencia de día u horario?',
  '¿Tiene algún examen reciente?',
  '¿Desde cuándo tiene psoriasis?',
  '¿Tiene cita para hoy?',
  'Para definir el tratamiento, necesita una consulta con el dermatólogo.',
  'La biopsia es el examen que confirma si es cáncer.',
  'Si es cáncer de piel, el Dr. Diego hace la cirugía de Mohs.',
  'En caso de melanoma, el equipo prioriza su atención.',
  'Si tiene alergia a algún medicamento, avise en recepción.',
  'No use pomada en la zona antes del procedimiento.',
  'No puede aplicar crema el día del láser.',
  'Tome nota de la dirección: Calle Santa Clara, 50.',
  'Puede usar el estacionamiento del edificio.',
  'Puede ponerse en contacto por WhatsApp.',
  'Pase a recepción 15 minutos antes.',
  'Presenta el documento en recepción.',
  'Beba 500 ml de agua antes del examen.',
  'La consulta cuesta 450 pesos.',
  // otros nichos, em espanhol, com as mesmas palavras
  'Tiene un 10 % de descuento en su primera compra.',
  'Use el cupón BIENVENIDO en el carrito.',
  'Garantizo la entrega para el viernes.',
  'El sérum de 30 ml cuesta 120 pesos.',
  // terceira pessoa genérica com "si"/"quien": serviço, não diagnóstico
  'Si usted tiene alergia a algún medicamento, avísenos antes.',
  'Si tú tienes alergia, avisa antes.',
  'Para saber si usted tiene una infección, necesita la consulta.',
  'Quien tiene acné puede hacer el peeling.',
  'Si el paciente tiene herpes, el procedimiento se reprograma.',
  'Si su hijo tiene alergia, avise en recepción.',
  'El láser no se recomienda para quien tiene herpes activo.',
  'Usted tiene cita mañana a las 9.',
  'La consulta incluye una crema hidratante de regalo.',
];

describe('detectarAfirmacaoClinica', () => {
  it.each(barra)('barra %s: %s', (categoria, frase) => {
    const achado = detectarAfirmacaoClinica(frase);
    expect(achado.achou).toBe(true);
    expect(achado.categorias).toContain(categoria);
  });

  it.each(passa)('deixa passar: %s', (frase) => {
    expect(detectarAfirmacaoClinica(frase)).toEqual({ achou: false, categorias: [] });
  });

  it('a hipótese vale só para a frase em que está', () => {
    // A primeira frase é hipótese; a segunda afirma. A segunda tem de barrar.
    const achado = detectarAfirmacaoClinica('Se for câncer, a equipe prioriza. Mas pela foto é um melanoma.');
    expect(achado.categorias).toEqual(['afirmacao_oncologica']);
  });

  it('a hipótese vale só para a frase em que está, em espanhol', () => {
    const achado = detectarAfirmacaoClinica(
      'Si es cáncer, el equipo prioriza. Pero por la foto es un melanoma.',
    );
    expect(achado.categorias).toEqual(['afirmacao_oncologica']);
  });

  it('junta categorias diferentes na mesma mensagem, sem repetir', () => {
    const achado = detectarAfirmacaoClinica('Você tem micose. Passe o antifúngico. Passe a pomada também.');
    expect(achado.categorias.sort()).toEqual(['diagnostico', 'prescricao']);
  });

  it('junta categorias diferentes na mesma mensagem, sem repetir, em espanhol', () => {
    const achado = detectarAfirmacaoClinica('Tienes hongos. Aplíquese el antifúngico. Aplíquese la pomada también.');
    expect(achado.categorias.sort()).toEqual(['diagnostico', 'prescricao']);
  });
});

describe('renderVetoDeAfirmacaoClinica', () => {
  it('diz o que foi barrado e o que escrever no lugar', () => {
    const texto = renderVetoDeAfirmacaoClinica(['diagnostico', 'prescricao']);
    expect(texto).toContain('não diga o que a pessoa tem');
    expect(texto).toContain('não indique remédio, pomada nem dose');
    expect(texto).toContain('quem avalia é o médico');
    expect(texto).toContain('ofereça o agendamento');
  });
});
