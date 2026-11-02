/**
 * "ENVIAR TESTE" do aviso de agendamento: o número e, se houver, o grupo.
 *
 * Cada destino passa pela MESMA fila de condições do aviso de caso
 * (`enviarAvisoDeTeste`), um depois do outro. O grupo sai pela mesma conexão
 * que acabou de mandar ao número, então o anti-ban pede o intervalo de ~1,2 s
 * entre os dois: em vez de devolver "espere" para quem clicou uma vez, o teste
 * espera esse intervalo e tenta o grupo de novo, quantas vezes precisar, até
 * `ESPERA_MAXIMA_DO_GRUPO_MS` contados da primeira tentativa. Uma só não
 * basta: o pacing sorteia o jitter de novo a cada consulta, então o `liberaEm`
 * da segunda resposta pode cair depois do da primeira. O espaçamento continua
 * valendo; o teste só espera por ele. Teto diário não é esperado: ele só libera
 * no dia seguinte.
 *
 * O grupo é destino EXTRA, como no envio real: o desfecho dele vem separado e
 * nunca muda o do número.
 */
import {
  enviarAvisoDeTeste,
  type DepsDoAvisoDeTeste,
  type MotivoDoTeste,
  type ResultadoDoAvisoDeTeste,
} from "@/lib/escalacao/aviso-de-teste";

/** O espaçamento do anti-ban é 1,2 s mais até 0,8 s de variação; 5 s cobre com folga. */
export const ESPERA_MAXIMA_DO_GRUPO_MS = 5_000;

/** O que a tela precisa saber do grupo: saiu ou não, e por quê. Sem o endereço. */
export type ResultadoDoTesteNoGrupo =
  | { enviado: true }
  | { enviado: false; codigo: MotivoDoTeste; liberaEm?: string };

export type ResultadoDoTesteDeAgendamento = ResultadoDoAvisoDeTeste & {
  /** `null` quando não há grupo escolhido. */
  grupo: ResultadoDoTesteNoGrupo | null;
};

const esperarDeVerdade = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function doGrupo(r: ResultadoDoAvisoDeTeste): ResultadoDoTesteNoGrupo {
  if (r.enviado) return { enviado: true };
  return { enviado: false, codigo: r.codigo, ...(r.liberaEm ? { liberaEm: r.liberaEm } : {}) };
}

export async function enviarTesteDoAvisoDeAgendamento(
  deps: DepsDoAvisoDeTeste,
  entrada: {
    organizationId: string;
    channelSessionId: string;
    telefone: string;
    /** O `chatId` (`…@g.us`) do grupo salvo, ou `null`. */
    grupo: string | null;
    corpo: NonNullable<Parameters<typeof enviarAvisoDeTeste>[1]["corpo"]>;
  },
  esperar: (ms: number) => Promise<void> = esperarDeVerdade,
): Promise<ResultadoDoTesteDeAgendamento> {
  const { grupo, ...comum } = entrada;
  const numero = await enviarAvisoDeTeste(deps, comum);
  if (!grupo) return { ...numero, grupo: null };

  const noGrupo = () => enviarAvisoDeTeste(deps, { ...comum, telefone: grupo });
  const limite = deps.clock().getTime() + ESPERA_MAXIMA_DO_GRUPO_MS;
  let r = await noGrupo();
  while (!r.enviado && r.codigo === "espacamento" && r.liberaEm) {
    const liberaEm = Date.parse(r.liberaEm);
    if (liberaEm > limite) break;
    await esperar(Math.max(0, liberaEm - deps.clock().getTime()));
    r = await noGrupo();
  }
  return { ...numero, grupo: doGrupo(r) };
}
