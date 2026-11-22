/** Janela já configurada na cadência, interpretada no seu fuso, não no da VPS. */
import type { ConfiguracaoDaCadencia, DiaDaSemana } from "./tipos";
const DIA: Record<string, DiaDaSemana> = { Mon: "seg", Tue: "ter", Wed: "qua", Thu: "qui", Fri: "sex", Sat: "sab", Sun: "dom" };
export function dentroDaJanela(config: ConfiguracaoDaCadencia, agora: Date): boolean {
  try {
    const partes = new Intl.DateTimeFormat("en-GB", { timeZone: config.fuso, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(agora);
    const ler = (tipo: Intl.DateTimeFormatPartTypes) => partes.find((p) => p.type === tipo)?.value ?? "";
    const dia = DIA[ler("weekday")];
    const hora = `${ler("hour")}:${ler("minute")}`;
    return !!dia && config.janela.dias.includes(dia) && hora >= config.janela.inicio && hora < config.janela.fim;
  } catch { return false; }
}
