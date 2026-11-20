/**
 * Os sons da ligação no Cold Call: discando, atendeu, recusou e encerrou. Sintetizados na hora, sem
 * arquivo para baixar. O navegador só libera som depois de um clique, por isso o botão de
 * ligar chama `liberarSons` antes de qualquer coisa tocar.
 */

/** O toque de chamada no Brasil: 425 Hz, 1 s ligado e 4 s em silêncio. */
const TOQUE_HZ = 425;
const TOQUE_LIGADO_S = 1;
const CICLO_DO_TOQUE_MS = 5000;
const TEMPO_DOS_DIGITOS_S = 0.72;
/** Pares de frequência das teclas do telefone, para o efeito de número sendo discado. */
const DIGITOS: readonly (readonly [number, number])[] = [
  [770, 1336],
  [941, 1209],
  [697, 1477],
  [852, 1336],
  [770, 1209],
  [697, 1336],
];

let contexto: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined" || !window.AudioContext) return null;
  contexto ??= new AudioContext();
  return contexto;
}

export function liberarSons(): void {
  void audio()?.resume();
}

function tom(a: AudioContext, destino: AudioNode, hz: number, inicio: number, duracao: number, pico: number): void {
  const oscilador = a.createOscillator();
  const volume = a.createGain();
  oscilador.frequency.setValueAtTime(hz, inicio);
  volume.gain.setValueAtTime(0.0001, inicio);
  volume.gain.exponentialRampToValueAtTime(pico, inicio + 0.015);
  volume.gain.setValueAtTime(pico, Math.max(inicio + 0.015, inicio + duracao - 0.03));
  volume.gain.exponentialRampToValueAtTime(0.0001, inicio + duracao);
  oscilador.connect(volume);
  volume.connect(destino);
  oscilador.start(inicio);
  oscilador.stop(inicio + duracao + 0.02);
}

/** Toca os dígitos e depois o toque de chamada em ciclo, até a função devolvida ser chamada. */
export function tocarDiscando(): () => void {
  const a = audio();
  if (!a) return () => {};
  void a.resume();
  const saida = a.createGain();
  saida.connect(a.destination);

  const inicio = a.currentTime + 0.02;
  DIGITOS.forEach(([grave, agudo], i) => {
    tom(a, saida, grave, inicio + i * 0.12, 0.08, 0.05);
    tom(a, saida, agudo, inicio + i * 0.12, 0.08, 0.05);
  });

  const umToque = (quando: number) => tom(a, saida, TOQUE_HZ, quando, TOQUE_LIGADO_S, 0.1);
  umToque(inicio + TEMPO_DOS_DIGITOS_S);
  const ciclo = window.setInterval(() => umToque(a.currentTime + 0.01), CICLO_DO_TOQUE_MS);

  return () => {
    window.clearInterval(ciclo);
    // Desligar a saída cala na hora até o tom que já estava agendado.
    saida.disconnect();
  };
}

/** Sobe em três notas: dá para perceber sem olhar para a tela que o cliente atendeu. */
export function tocarAtendeu(): void {
  const a = audio();
  if (!a) return;
  void a.resume();
  const inicio = a.currentTime + 0.01;
  [659, 880, 1175].forEach((hz, i) => tom(a, a.destination, hz, inicio + i * 0.1, i === 2 ? 0.28 : 0.11, 0.14));
}

/** Desce em duas notas, curtas. */
export function tocarEncerrou(): void {
  const a = audio();
  if (!a) return;
  void a.resume();
  const inicio = a.currentTime + 0.01;
  [494, 330].forEach((hz, i) => tom(a, a.destination, hz, inicio + i * 0.16, 0.17, 0.11));
}

/** O sinal de ocupado brasileiro: 425 Hz, 250 ms ligado e 250 ms desligado. */
export function tocarRecusada(): void {
  const a = audio();
  if (!a) return;
  void a.resume();
  const inicio = a.currentTime + 0.01;
  for (let i = 0; i < 5; i++) tom(a, a.destination, TOQUE_HZ, inicio + i * 0.5, 0.25, 0.12);
}
