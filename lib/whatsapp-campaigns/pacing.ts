/**
 * Pacing de campanha — intervalo variável [min,max] segundos.
 * Piso de aplicação: 5s (doutrina / anti-burst). Não copia agent-engine cegamente.
 */
export const CAMPAIGN_MIN_INTERVAL_FLOOR_SEC = 5;

export function randomIntervalMs(minSec: number, maxSec: number, rng = Math.random): number {
  const lo = Math.max(CAMPAIGN_MIN_INTERVAL_FLOOR_SEC, Math.min(minSec, maxSec));
  const hi = Math.max(lo, Math.max(minSec, maxSec));
  const sec = lo + rng() * (hi - lo);
  return Math.floor(sec * 1000);
}

export function nextSendAtIso(
  minSec: number,
  maxSec: number,
  from = new Date(),
  rng = Math.random,
): string {
  return new Date(from.getTime() + randomIntervalMs(minSec, maxSec, rng)).toISOString();
}

/** Próxima abertura da janela [start,end) no timezone IANA. */
export function nextWindowOpen(
  now: Date,
  windowStart: string | null, // HH:MM:SS or HH:MM
  windowEnd: string | null,
  timeZone: string,
): Date | null {
  if (!windowStart || !windowEnd) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const y = get("year");
  const mo = get("month");
  const d = get("day");
  const h = get("hour");
  const mi = get("minute");
  const s = get("second");

  const parseHm = (raw: string) => {
    const [hh, mm, ss] = raw.split(":").map(Number);
    return { hh: hh ?? 0, mm: mm ?? 0, ss: ss ?? 0 };
  };
  const start = parseHm(windowStart);
  const end = parseHm(windowEnd);

  const curSec = h * 3600 + mi * 60 + s;
  const startSec = start.hh * 3600 + start.mm * 60 + start.ss;
  const endSec = end.hh * 3600 + end.mm * 60 + end.ss;

  const inWindow =
    startSec <= endSec
      ? curSec >= startSec && curSec < endSec
      : curSec >= startSec || curSec < endSec; // overnight

  if (inWindow) return null;

  // Próximo start hoje ou amanhã (aproximação: reconstrói instante UTC via offset)
  const guessLocalAsUtc = (dayOffset: number) => {
    const label = `${y}-${String(mo).padStart(2, "0")}-${String(d + dayOffset).padStart(2, "0")}T${String(start.hh).padStart(2, "0")}:${String(start.mm).padStart(2, "0")}:${String(start.ss).padStart(2, "0")}`;
    // Fallback: trata como se o fuso fosse o offset atual do TZ
    const probe = new Date(now.toLocaleString("en-US", { timeZone }));
    const utc = new Date(now.getTime() + (now.getTime() - probe.getTime()));
    void utc;
    // Usa Temporal-less trick: diferença formatada
    const asIf = new Date(
      Date.parse(
        new Date(`${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(start.hh).padStart(2, "0")}:${String(start.mm).padStart(2, "0")}:00`).toLocaleString(
          "en-US",
          { timeZone: "UTC" },
        ),
      ),
    );
    void label;
    void dayOffset;
    return asIf;
  };

  // Implementação prática: adia 1h e reavalia no worker (ou calcula via offset)
  // Calcula milis até startSec no mesmo dia local
  let deltaSec = startSec - curSec;
  if (deltaSec <= 0) deltaSec += 86400;
  return new Date(now.getTime() + deltaSec * 1000);
}

export function isInsideSendWindow(
  now: Date,
  windowStart: string | null,
  windowEnd: string | null,
  timeZone: string,
): boolean {
  if (!windowStart || !windowEnd) return true;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const cur = get("hour") * 3600 + get("minute") * 60 + get("second");
  const parse = (raw: string) => {
    const [hh, mm, ss] = raw.split(":").map(Number);
    return (hh ?? 0) * 3600 + (mm ?? 0) * 60 + (ss ?? 0);
  };
  const a = parse(windowStart);
  const b = parse(windowEnd);
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
}
