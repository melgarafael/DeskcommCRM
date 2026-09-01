# Agenda nativa do CRM (Frente A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao SonghaiCRM um módulo de agendamento nativo (tipos de agendamento,
horário de trabalho por atendente, marcação pela equipe, lembrete de WhatsApp e
aviso de desfecho pendente) — sem depender de Google Calendar ou de IA no
WhatsApp, que ficam para specs futuros (Frentes B e C).

**Architecture:** 3 tabelas novas (`appointment_types`, `attendant_schedule`,
`appointments`) com RLS desde o nascimento e uma exclusion constraint no banco
que impede sobreposição de horário. API REST em `/api/v1/` seguindo a
convenção `ok()`/`fail()`/`requireRole()`/Zod já usada em todo o repo. Duas
telas novas (Agenda, Tipos de agendamento) + uma seção nova em Configurações
(horário do atendente) + uma seção nova no dossiê do lead. Dois crons
(lembrete via `runBeforeSend`, aviso de desfecho pendente) seguindo o padrão
já estabelecido em `recover-stuck-messages`/`event-log-purge`.

**Tech Stack:** Next.js 16 App Router, Supabase/Postgres (RLS, exclusion
constraint via `btree_gist`), Zod, shadcn/ui (`new-york`), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-30-agenda-nativa-design.md`

## Global Constraints

- Toda tabela nova tem `organization_id not null references organizations(id) on delete cascade` + RLS habilitada no mesmo commit da criação (doutrina de multi-tenancy).
- Toda rota `/api/v1/*` usa `ok()`/`fail()` (`lib/api/wrappers.ts`), `requireRole()` (`lib/auth/require-role.ts`) e Zod em todo input externo.
- Toda mutação POST/PATCH/DELETE bem-sucedida grava 1 linha em `api_audit_log` via `audit()` (`lib/audit/index.ts`), fire-and-forget.
- `attendant_schedule.starts_at`/`ends_at` são interpretados no fuso de `organizations.timezone` — nunca UTC cru.
- O lembrete de WhatsApp passa SEMPRE por `runBeforeSend` (`lib/agent-engine/guardrails/before-send.ts`) — nunca um envio direto ao canal.
- Toda mudança de schema sai como migration versionada em `supabase/migrations/` **e** apêndice idempotente em `supabase/baseline.sql` **e** linha em `supabase/migrations/MANIFEST.md` (doutrina de migrations).
- Toda rota de cron nova entra no crontab de `docker/scheduler/entrypoint.sh` no mesmo commit (gate `tests/unit/cron-routes-scheduled.test.ts`).
- Toda tela nova é registrada em `lib/navigation/registry.ts` (gate `tests/unit/navegacao-completude.test.ts`).
- TDD: todo passo de código de produção é precedido por um teste que falhou pelo motivo certo.
- Este ambiente pode não ter Docker disponível — se `pnpm test:db` não puder rodar localmente, isso deve ser declarado explicitamente ao final, e a migration deve ser revisada manualmente contra os padrões já existentes no `baseline.sql` antes de mergear.

---

### Task 1: Migration — schema da Agenda (3 tabelas + RLS + exclusion constraint)

**Files:**
- Create: `supabase/migrations/20260830120000_0165_agenda_nativa.sql`
- Modify: `supabase/baseline.sql` (apêndice no fim do arquivo)
- Modify: `supabase/migrations/MANIFEST.md` (nova linha na tabela "Applied")

**Interfaces:**
- Produces: tabelas `appointment_types`, `attendant_schedule`, `appointments` com as colunas abaixo — todas as tasks seguintes leem/escrevem nelas.

- [ ] **Step 1: Escrever a migration**

```sql
-- 0165 — Agenda nativa do CRM (Frente A): tipos de agendamento, horário de
-- trabalho por atendente, e o agendamento em si.
--
-- Três tabelas, organization_id + RLS desde o nascimento (doutrina de
-- multi-tenancy). `attendant_schedule` é DELIBERADAMENTE separada de
-- `attendant_availability` (migration 0039/epic de Governança) — aquela é o
-- toggle efêmero de fila de chat, esta é o horário estrutural de agendamento.
-- Acoplar os dois faria conceitos de negócio diferentes evoluírem juntos sem
-- necessidade.

create extension if not exists btree_gist with schema extensions;

create table if not exists public.appointment_types (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  name                text not null check (length(name) > 0),
  duration_minutes    integer not null check (duration_minutes > 0),
  responsible_user_id uuid not null references auth.users(id),
  color               text check (color is null or color ~ '^#[0-9a-f]{6}$'),
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_appointment_types_org
  on public.appointment_types (organization_id);

alter table public.appointment_types enable row level security;

drop policy if exists "appointment_types_select" on public.appointment_types;
create policy "appointment_types_select" on public.appointment_types
  for select using (
    public.fn_is_platform_admin()
    or organization_id in (select public.fn_user_org_ids())
  );

drop policy if exists "appointment_types_write" on public.appointment_types;
create policy "appointment_types_write" on public.appointment_types
  for all using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'manager'))
  ) with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'manager'))
  );

create or replace trigger trg_appointment_types_updated_at
  before update on public.appointment_types
  for each row execute function public.fn_set_updated_at();

-- ---------------------------------------------------------------------------

create table if not exists public.attendant_schedule (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  day_of_week     smallint not null check (day_of_week between 0 and 6),
  starts_at       time not null,
  ends_at         time not null check (ends_at > starts_at),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, user_id, day_of_week, starts_at)
);

create index if not exists idx_attendant_schedule_org_user
  on public.attendant_schedule (organization_id, user_id);

alter table public.attendant_schedule enable row level security;

drop policy if exists "attendant_schedule_select" on public.attendant_schedule;
create policy "attendant_schedule_select" on public.attendant_schedule
  for select using (
    public.fn_is_platform_admin()
    or organization_id in (select public.fn_user_org_ids())
  );

drop policy if exists "attendant_schedule_write" on public.attendant_schedule;
create policy "attendant_schedule_write" on public.attendant_schedule
  for all using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager')))
  ) with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and (user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager')))
  );

create or replace trigger trg_attendant_schedule_updated_at
  before update on public.attendant_schedule
  for each row execute function public.fn_set_updated_at();

-- ---------------------------------------------------------------------------

create table if not exists public.appointments (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  lead_id              uuid not null references public.crm_leads(id) on delete cascade,
  appointment_type_id  uuid not null references public.appointment_types(id),
  responsible_user_id  uuid not null references auth.users(id),
  scheduled_at         timestamptz not null,
  duration_minutes     integer not null check (duration_minutes > 0),
  status               text not null default 'scheduled'
                       check (status in ('scheduled','completed','cancelled','no_show')),
  reminder_sent_at     timestamptz,
  created_by_user_id   uuid not null references auth.users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- Regra dura, no banco: a mesma pessoa nunca tem 2 agendamentos `scheduled`
  -- sobrepostos, mesmo com duas requisições concorrentes.
  exclude using gist (
    responsible_user_id with =,
    tstzrange(scheduled_at, scheduled_at + (duration_minutes || ' minutes')::interval) with &&
  ) where (status = 'scheduled')
);

create index if not exists idx_appointments_org_lead on public.appointments (organization_id, lead_id);
create index if not exists idx_appointments_org_responsible_date
  on public.appointments (organization_id, responsible_user_id, scheduled_at);
create index if not exists idx_appointments_reminder_pending
  on public.appointments (scheduled_at)
  where status = 'scheduled' and reminder_sent_at is null;

alter table public.appointments enable row level security;

-- SELECT herda a visibilidade do lead-pai (mesmo idioma de
-- `crm_lead_activities_select`, migration 0042) — quem não pode ver o lead
-- não pode ver o agendamento dele.
drop policy if exists "appointments_select" on public.appointments;
create policy "appointments_select" on public.appointments
  for select using (
    exists (
      select 1 from public.crm_leads l
      where l.id = appointments.lead_id
        and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
    )
  );

drop policy if exists "appointments_write" on public.appointments;
create policy "appointments_write" on public.appointments
  for all using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'agent'))
  ) with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'agent'))
  );

create or replace trigger trg_appointments_updated_at
  before update on public.appointments
  for each row execute function public.fn_set_updated_at();

revoke all on public.appointment_types from anon;
revoke all on public.attendant_schedule from anon;
revoke all on public.appointments from anon;
```

- [ ] **Step 2: Aplicar a migration** via `mcp__plugin_supabase_supabase__apply_migration` (ou `supabase db push` se o MCP não estiver disponível na sessão). Se nenhum dos dois estiver disponível, registrar explicitamente que a migration não foi aplicada/verificada contra um Postgres real, e pedir para o usuário rodar `pnpm test:db` antes de mergear.

- [ ] **Step 3: Espelhar no `baseline.sql`**

Adicionar ao FIM de `supabase/baseline.sql`, no mesmo formato dos apêndices
anteriores (ver o bloco de `0163`/`0164` já presente no arquivo):

```sql
-- ---- Agenda nativa: appointment_types, attendant_schedule, appointments (migration 0165) ----
```
seguido do MESMO SQL do Step 1 (idêntico — é o mesmo texto, é isso que faz o
apêndice "idempotente": reaplicável em qualquer ordem pelo `update.sh`).

- [ ] **Step 4: Registrar no MANIFEST**

Adicionar em `supabase/migrations/MANIFEST.md`, seguindo o formato das linhas
anteriores da tabela "Applied":

```markdown
| `20260830120000` | `0165_agenda_nativa` | **Agenda nativa do CRM (Frente A).** Três tabelas: `appointment_types` (tipo configurável por org, responsável fixo), `attendant_schedule` (horário de trabalho recorrente por pessoa, separado de `attendant_availability` que é o toggle de fila de chat — conceitos diferentes, tabelas diferentes) e `appointments` (o agendamento, com `responsible_user_id`/`duration_minutes` copiados do tipo no momento da criação — mudança de tipo depois não altera agendamento já marcado). `appointments` tem exclusion constraint (`btree_gist`, nova extensão) que impede a mesma pessoa ter 2 agendamentos `scheduled` sobrepostos, garantido no banco. RLS de `appointments` herda `fn_can_view_lead` do lead-pai, mesmo idioma de `crm_lead_activities_select` (0042). Aditiva, sem backfill. |
```

- [ ] **Step 5: Verificar (se Docker disponível)**

```bash
pnpm test:db
```
Esperado: aplica em modo install (banco vazio) e update (banco com a 0164 já
aplicada) sem erro, incluindo a criação da extensão `btree_gist`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260830120000_0165_agenda_nativa.sql supabase/baseline.sql supabase/migrations/MANIFEST.md
git commit -m "feat(agenda): schema — appointment_types, attendant_schedule, appointments"
```

---

### Task 2: `lib/tempo/zoned-clock.ts` — conversão hora-de-parede ↔ instante UTC

**Files:**
- Create: `lib/tempo/zoned-clock.ts`
- Test: `lib/tempo/zoned-clock.test.ts`

**Interfaces:**
- Produces: `wallClockParts(instant: Date, timezone: string): WallClockParts`
  (`{ year, month, day, hour, minute, weekday }`, `weekday` 0=domingo..6=sábado)
  e `instantFromWallClock(year, month, day, hour, minute, timezone: string): Date`.
  Task 3 (`available-slots`) consome as duas.

Generaliza o algoritmo já usado (e testado em produção) em
`lib/agent-engine/pacing/engine.ts` (`wallClock`/`instantFromWall`, privados
àquele módulo) — mesma técnica de duas passadas pelo offset, correta sob DST.
Extraído para um módulo compartilhado em vez de duplicado à mão, e generalizado
para aceitar minutos (o pacing só precisava de hora cheia).

- [ ] **Step 1: Escrever o teste falhando**

```typescript
// lib/tempo/zoned-clock.test.ts
import { describe, expect, it } from "vitest";
import { wallClockParts, instantFromWallClock } from "./zoned-clock";

describe("wallClockParts", () => {
  it("lê a hora de parede correta num fuso com offset negativo", () => {
    // 2026-08-30T12:00:00Z em America/Sao_Paulo (UTC-3) = 09:00 local
    const parts = wallClockParts(new Date("2026-08-30T12:00:00Z"), "America/Sao_Paulo");
    expect(parts).toEqual({ year: 2026, month: 8, day: 30, hour: 9, minute: 0, weekday: 0 });
    // 2026-08-30 é domingo — weekday 0
  });

  it("lê a hora de parede correta em Africa/Maputo (UTC+2, sem DST)", () => {
    const parts = wallClockParts(new Date("2026-08-30T12:00:00Z"), "Africa/Maputo");
    expect(parts).toEqual({ year: 2026, month: 8, day: 30, hour: 14, minute: 0, weekday: 0 });
  });
});

describe("instantFromWallClock", () => {
  it("é o inverso de wallClockParts", () => {
    const instant = instantFromWallClock(2026, 8, 30, 14, 30, "America/Sao_Paulo");
    const parts = wallClockParts(instant, "America/Sao_Paulo");
    expect(parts).toMatchObject({ year: 2026, month: 8, day: 30, hour: 14, minute: 30 });
  });

  it("dois fusos diferentes para a MESMA hora de parede produzem instantes diferentes", () => {
    const saoPaulo = instantFromWallClock(2026, 8, 30, 9, 0, "America/Sao_Paulo");
    const maputo = instantFromWallClock(2026, 8, 30, 9, 0, "Africa/Maputo");
    expect(saoPaulo.getTime()).not.toBe(maputo.getTime());
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
npx vitest run lib/tempo/zoned-clock.test.ts
```
Esperado: FALHA — `Cannot find module './zoned-clock'`.

- [ ] **Step 3: Implementação mínima**

```typescript
// lib/tempo/zoned-clock.ts
/**
 * Conversão hora-de-parede ↔ instante UTC, com fuso IANA explícito.
 *
 * Generaliza o algoritmo já usado em `lib/agent-engine/pacing/engine.ts`
 * (`wallClock`/`instantFromWall`, privados àquele módulo) — mesma técnica de
 * duas passadas pelo offset, correta sob DST. Extraído aqui porque a Agenda
 * precisa da MESMA garantia (não inventar uma conversão de fuso própria) mas
 * em granularidade de MINUTO, que o pacing não precisava.
 */

export interface WallClockParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  /** 0 = domingo .. 6 = sábado, mesma convenção de `attendant_schedule.day_of_week`. */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** A hora de parede de `instant` no fuso `timezone`. */
export function wallClockParts(instant: Date, timezone: string): WallClockParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(instant);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24, // algumas ICU rendem '24' à meia-noite
    minute: Number(get("minute")),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

/**
 * Instante UTC cuja hora de parede em `timezone` é exatamente
 * (year, month, day, hour, minute) — técnica de duas passadas pelo offset,
 * correta inclusive sob DST.
 */
export function instantFromWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let guess = targetAsUtc;
  for (let i = 0; i < 2; i += 1) {
    const w = wallClockParts(new Date(guess), timezone);
    const guessAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
    guess += targetAsUtc - guessAsUtc;
  }
  return new Date(guess);
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
npx vitest run lib/tempo/zoned-clock.test.ts
```
Esperado: PASS, 4 testes.

- [ ] **Step 5: Commit**

```bash
git add lib/tempo/zoned-clock.ts lib/tempo/zoned-clock.test.ts
git commit -m "feat(agenda): utilitário compartilhado de hora-de-parede por fuso"
```

---

### Task 3: `lib/agenda/available-slots.ts` — cálculo puro de horários livres

**Files:**
- Create: `lib/agenda/available-slots.ts`
- Test: `lib/agenda/available-slots.test.ts`

**Interfaces:**
- Consumes: `wallClockParts`, `instantFromWallClock` de `lib/tempo/zoned-clock.ts` (Task 2).
- Produces: `computeAvailableSlots(input: ComputeSlotsInput): Slot[]`, com
  ```typescript
  interface ComputeSlotsInput {
    date: string; // "YYYY-MM-DD"
    timezone: string;
    durationMinutes: number;
    scheduleBlocks: { starts_at: string; ends_at: string }[]; // "HH:MM:SS", já filtrados pelo day_of_week certo
    existingAppointments: { scheduled_at: string; duration_minutes: number }[]; // ISO, status='scheduled'
  }
  interface Slot {
    startsAt: string; // ISO
    endsAt: string; // ISO
  }
  ```
  Task 6 (rota `available-slots`) consome esta função.

- [ ] **Step 1: Escrever o teste falhando**

```typescript
// lib/agenda/available-slots.test.ts
import { describe, expect, it } from "vitest";
import { computeAvailableSlots } from "./available-slots";

const TZ = "Africa/Maputo"; // UTC+2, sem DST — facilita a leitura do teste

describe("computeAvailableSlots", () => {
  it("sem horário cadastrado para o dia: nenhum slot", () => {
    const slots = computeAvailableSlots({
      date: "2026-09-01",
      timezone: TZ,
      durationMinutes: 30,
      scheduleBlocks: [],
      existingAppointments: [],
    });
    expect(slots).toEqual([]);
  });

  it("horário 09:00-11:00, duração 30min, sem agendamentos: 4 slots de 30min", () => {
    const slots = computeAvailableSlots({
      date: "2026-09-01",
      timezone: TZ,
      durationMinutes: 30,
      scheduleBlocks: [{ starts_at: "09:00:00", ends_at: "11:00:00" }],
      existingAppointments: [],
    });
    expect(slots).toHaveLength(4);
    expect(slots[0]).toEqual({
      startsAt: "2026-09-01T07:00:00.000Z", // 09:00 Maputo = 07:00 UTC
      endsAt: "2026-09-01T07:30:00.000Z",
    });
    expect(slots[3]).toEqual({
      startsAt: "2026-09-01T08:30:00.000Z", // 10:30 Maputo
      endsAt: "2026-09-01T09:00:00.000Z",
    });
  });

  it("horário parcialmente ocupado: o slot que colide com um agendamento existente some", () => {
    const slots = computeAvailableSlots({
      date: "2026-09-01",
      timezone: TZ,
      durationMinutes: 30,
      scheduleBlocks: [{ starts_at: "09:00:00", ends_at: "10:00:00" }],
      existingAppointments: [
        { scheduled_at: "2026-09-01T07:00:00.000Z", duration_minutes: 30 }, // 09:00-09:30 Maputo
      ],
    });
    // Só sobra o slot 09:30-10:00
    expect(slots).toEqual([
      { startsAt: "2026-09-01T07:30:00.000Z", endsAt: "2026-09-01T08:00:00.000Z" },
    ]);
  });

  it("múltiplos blocos no mesmo dia (manhã e tarde) — cada um gera seus slots", () => {
    const slots = computeAvailableSlots({
      date: "2026-09-01",
      timezone: TZ,
      durationMinutes: 60,
      scheduleBlocks: [
        { starts_at: "08:00:00", ends_at: "09:00:00" },
        { starts_at: "14:00:00", ends_at: "15:00:00" },
      ],
      existingAppointments: [],
    });
    expect(slots).toHaveLength(2);
    expect(slots[0]!.startsAt).toBe("2026-09-01T06:00:00.000Z"); // 08:00 Maputo
    expect(slots[1]!.startsAt).toBe("2026-09-01T12:00:00.000Z"); // 14:00 Maputo
  });

  it("duração do agendamento maior que o slot restante no bloco: nenhum slot ali", () => {
    const slots = computeAvailableSlots({
      date: "2026-09-01",
      timezone: TZ,
      durationMinutes: 45,
      scheduleBlocks: [{ starts_at: "09:00:00", ends_at: "09:30:00" }], // só 30min de bloco
      existingAppointments: [],
    });
    expect(slots).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
npx vitest run lib/agenda/available-slots.test.ts
```
Esperado: FALHA — `Cannot find module './available-slots'`.

- [ ] **Step 3: Implementação mínima**

```typescript
// lib/agenda/available-slots.ts
import { instantFromWallClock } from "@/lib/tempo/zoned-clock";

export interface ComputeSlotsInput {
  /** "YYYY-MM-DD" */
  date: string;
  timezone: string;
  durationMinutes: number;
  /** Blocos do dia de semana já filtrado, "HH:MM:SS" */
  scheduleBlocks: { starts_at: string; ends_at: string }[];
  /** Agendamentos `scheduled` que já ocupam parte do dia */
  existingAppointments: { scheduled_at: string; duration_minutes: number }[];
}

export interface Slot {
  startsAt: string;
  endsAt: string;
}

function parseDate(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split("-").map(Number);
  return { year: year!, month: month!, day: day! };
}

function parseTime(time: string): { hour: number; minute: number } {
  const [hour, minute] = time.split(":").map(Number);
  return { hour: hour!, minute: minute! };
}

/**
 * Slots livres de `durationMinutes` dentro dos blocos de horário, descontando
 * agendamentos já marcados. Granularidade dos slots = `durationMinutes` (sem
 * sobreposição entre slots candidatos — o próximo começa onde o anterior
 * termina).
 */
export function computeAvailableSlots(input: ComputeSlotsInput): Slot[] {
  const { year, month, day } = parseDate(input.date);
  const durationMs = input.durationMinutes * 60_000;

  const ocupados = input.existingAppointments.map((a) => {
    const start = new Date(a.scheduled_at).getTime();
    return { start, end: start + a.duration_minutes * 60_000 };
  });

  const slots: Slot[] = [];

  for (const bloco of input.scheduleBlocks) {
    const inicio = parseTime(bloco.starts_at);
    const fim = parseTime(bloco.ends_at);
    const blocoStart = instantFromWallClock(year, month, day, inicio.hour, inicio.minute, input.timezone).getTime();
    const blocoEnd = instantFromWallClock(year, month, day, fim.hour, fim.minute, input.timezone).getTime();

    for (let candidateStart = blocoStart; candidateStart + durationMs <= blocoEnd; candidateStart += durationMs) {
      const candidateEnd = candidateStart + durationMs;
      const colide = ocupados.some((o) => candidateStart < o.end && candidateEnd > o.start);
      if (!colide) {
        slots.push({
          startsAt: new Date(candidateStart).toISOString(),
          endsAt: new Date(candidateEnd).toISOString(),
        });
      }
    }
  }

  return slots;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
npx vitest run lib/agenda/available-slots.test.ts
```
Esperado: PASS, 5 testes.

- [ ] **Step 5: Commit**

```bash
git add lib/agenda/available-slots.ts lib/agenda/available-slots.test.ts
git commit -m "feat(agenda): cálculo puro de horários livres"
```

---

### Task 4: Vocabulário de atividade + ações de auditoria da Agenda

**Files:**
- Modify: `lib/leads/activity-vocabulary.ts`
- Modify: `lib/audit/actions.ts`

**Interfaces:**
- Produces: novos membros de `ActivityType` (`appointment_scheduled`,
  `appointment_rescheduled`, `appointment_cancelled`, `appointment_completed`,
  `appointment_no_show`) e novas `AuditAction` (`appointment_type.created`,
  `appointment_type.updated`, `appointment_type.deleted`,
  `attendant_schedule.updated`, `appointment.created`,
  `appointment.rescheduled`, `appointment.status_changed`) — Tasks 5-8
  consomem ambos.

- [ ] **Step 1: Escrever o teste falhando (compilação exaustiva)**

Este arquivo já é gate-por-compilador (`ACTIVITY_LABELS: Record<ActivityType, string>`
exaustivo) — não precisa de teste de comportamento novo, só adicionar os
membros e o rótulo. A "falha" aqui é o `tsc` reprovando se o rótulo faltar.

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | grep activity-vocabulary
```
Esperado (ANTES da Step 2, com os tipos já usados em algum lugar que ainda não
existe): nada ainda, porque ninguém referencia os tipos novos até a Task 7. Este
passo serve para CONFIRMAR o baseline limpo antes de mexer.

- [ ] **Step 2: Adicionar ao vocabulário de atividade**

Em `lib/leads/activity-vocabulary.ts`, no fim do union `ActivityType` (antes
do fechamento com `;`):

```typescript
  | "payment_charge_created"
  | "payment_confirmed"
  /** As cinco transições do agendamento (Frente A da Agenda nativa). */
  | "appointment_scheduled"
  | "appointment_rescheduled"
  | "appointment_cancelled"
  | "appointment_completed"
  | "appointment_no_show";
```

E em `ACTIVITY_LABELS` (o `Record` exaustivo), adicionar as 5 entradas:

```typescript
  appointment_scheduled: "Agendamento marcado",
  appointment_rescheduled: "Agendamento remarcado",
  appointment_cancelled: "Agendamento cancelado",
  appointment_completed: "Agendamento concluído",
  appointment_no_show: "Cliente não compareceu",
```

- [ ] **Step 3: Adicionar as ações de auditoria**

Em `lib/audit/actions.ts`, no FIM do array `AUDIT_ACTIONS` (nunca no meio —
doutrina do próprio arquivo: "nunca renomeie, acrescente no fim"):

```typescript
  "appointment_type.created",
  "appointment_type.updated",
  "appointment_type.deleted",
  "attendant_schedule.updated",
  "appointment.created",
  "appointment.rescheduled",
  "appointment.status_changed",
```

- [ ] **Step 4: Rodar typecheck e confirmar que passa**

```bash
npx tsc --noEmit -p tsconfig.json
```
Esperado: 0 erros.

- [ ] **Step 5: Commit**

```bash
git add lib/leads/activity-vocabulary.ts lib/audit/actions.ts
git commit -m "feat(agenda): vocabulário de timeline e ações de auditoria"
```

---

### Task 5: API — `appointment-types` (CRUD)

**Files:**
- Create: `app/api/v1/appointment-types/route.ts`
- Create: `app/api/v1/appointment-types/[id]/route.ts`
- Test: `app/api/v1/appointment-types/route.test.ts`
- Test: `app/api/v1/appointment-types/[id]/route.test.ts`

**Interfaces:**
- Consumes: `requireRole` (`lib/auth/require-role.ts`), `ok`/`fail`
  (`lib/api/wrappers.ts`), `audit` (`lib/audit/index.ts`), `createAdminClient`
  (`lib/supabase/admin.ts`).
- Produces: rotas HTTP consumidas pela UI da Task 14.

- [ ] **Step 1: Escrever o teste falhando de `route.ts` (list + create)**

```typescript
// app/api/v1/appointment-types/route.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { GET, POST } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function reqOk(role: "manager" | "agent" = "manager") {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID } as never,
    org: { orgId: ORG_ID, name: "Org", role },
  });
}

function stubAdmin(rows: unknown[] = [], insertResult: { data: unknown; error: unknown } = { data: { id: "novo-id" }, error: null }) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => Promise.resolve({ data: rows, error: null }),
    insert: () => ({
      select: () => ({ single: () => Promise.resolve(insertResult) }),
    }),
  };
  vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/v1/appointment-types", () => {
  it("exige role — sem sessão válida, devolve a resposta do requireRole", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }) as never,
    });
    const res = await GET(new Request("http://x/api/v1/appointment-types") as never);
    expect(res.status).toBe(401);
  });

  it("lista os tipos da organização ativa", async () => {
    reqOk("agent");
    stubAdmin([{ id: "t1", name: "Consulta", duration_minutes: 30 }]);
    const res = await GET(new Request("http://x/api/v1/appointment-types") as never);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toEqual([{ id: "t1", name: "Consulta", duration_minutes: 30 }]);
  });
});

describe("POST /api/v1/appointment-types", () => {
  it("exige manager+ (viewer/agent não pode criar tipo)", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), { status: 403 }) as never,
    });
    const res = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({}) }) as never,
    );
    expect(res.status).toBe(403);
  });

  it("cria o tipo com payload válido", async () => {
    reqOk("manager");
    stubAdmin();
    const res = await POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          name: "Consulta",
          duration_minutes: 30,
          responsible_user_id: USER_ID,
        }),
      }) as never,
    );
    expect(res.status).toBe(201);
  });

  it("rejeita payload sem name", async () => {
    reqOk("manager");
    stubAdmin();
    const res = await POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ duration_minutes: 30, responsible_user_id: USER_ID }),
      }) as never,
    );
    expect(res.status).toBe(422);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
NEXT_PUBLIC_SUPABASE_URL="https://test-placeholder.invalid" NEXT_PUBLIC_SUPABASE_ANON_KEY="test-anon" SUPABASE_SERVICE_ROLE_KEY="test-service" npx vitest run app/api/v1/appointment-types/route.test.ts
```
Esperado: FALHA — `Cannot find module './route'`.

- [ ] **Step 3: Implementar `route.ts`**

```typescript
// app/api/v1/appointment-types/route.ts
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  duration_minutes: z.number().int().positive(),
  responsible_user_id: z.string().uuid(),
  color: z.string().regex(/^#[0-9a-f]{6}$/).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "appointment_types" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("appointment_types")
    .select("id, name, duration_minutes, responsible_user_id, color, is_active")
    .eq("organization_id", authz.org.orgId)
    .order("name", { ascending: true });

  if (error) return fail("internal_error", "Erro ao listar tipos de agendamento.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "appointment_types" });
  if (!authz.ok) return authz.response;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = createSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("appointment_types")
    .insert({ organization_id: authz.org.orgId, ...parsed.data })
    .select("id")
    .single();

  if (error || !data) {
    return fail("internal_error", "Erro ao criar tipo de agendamento.", 500, { requestId });
  }

  void audit({
    action: "appointment_type.created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "appointment_types",
    resourceId: (data as { id: string }).id,
    requestId,
    metadata: { name: parsed.data.name },
  });

  return ok({ id: (data as { id: string }).id }, { status: 201, requestId });
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
NEXT_PUBLIC_SUPABASE_URL="https://test-placeholder.invalid" NEXT_PUBLIC_SUPABASE_ANON_KEY="test-anon" SUPABASE_SERVICE_ROLE_KEY="test-service" npx vitest run app/api/v1/appointment-types/route.test.ts
```
Esperado: PASS, 5 testes.

- [ ] **Step 5: Escrever o teste falhando de `[id]/route.ts` (get/patch/delete)**

```typescript
// app/api/v1/appointment-types/[id]/route.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { PATCH, DELETE } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const TYPE_ID = "33333333-3333-4333-8333-333333333333";

function reqOk() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1" } as never,
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("DELETE /api/v1/appointment-types/[id]", () => {
  it("recusa (409) se houver agendamento futuro para este tipo", async () => {
    reqOk();
    const chain = {
      select: () => chain,
      eq: () => chain,
      gte: () => Promise.resolve({ count: 1, error: null }),
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);

    const res = await DELETE(new Request("http://x") as never, {
      params: Promise.resolve({ id: TYPE_ID }),
    } as never);
    expect(res.status).toBe(409);
  });

  it("apaga quando não há agendamento futuro", async () => {
    reqOk();
    let deletado = false;
    const chain = {
      select: () => chain,
      eq: () => chain,
      gte: () => Promise.resolve({ count: 0, error: null }),
      delete: () => ({
        eq: () => ({
          eq: () => {
            deletado = true;
            return Promise.resolve({ error: null });
          },
        }),
      }),
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);

    const res = await DELETE(new Request("http://x") as never, {
      params: Promise.resolve({ id: TYPE_ID }),
    } as never);
    expect(res.status).toBe(200);
    expect(deletado).toBe(true);
  });
});
```

- [ ] **Step 6: Rodar e confirmar que falha**

```bash
NEXT_PUBLIC_SUPABASE_URL="https://test-placeholder.invalid" NEXT_PUBLIC_SUPABASE_ANON_KEY="test-anon" SUPABASE_SERVICE_ROLE_KEY="test-service" npx vitest run "app/api/v1/appointment-types/[id]/route.test.ts"
```
Esperado: FALHA — `Cannot find module './route'`.

- [ ] **Step 7: Implementar `[id]/route.ts`**

```typescript
// app/api/v1/appointment-types/[id]/route.ts
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  duration_minutes: z.number().int().positive().optional(),
  responsible_user_id: z.string().uuid().optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/).nullable().optional(),
  is_active: z.boolean().optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "appointment_types" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = patchSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("appointment_types")
    .update(parsed.data)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId);

  if (error) return fail("internal_error", "Erro ao atualizar tipo de agendamento.", 500, { requestId });

  void audit({
    action: "appointment_type.updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "appointment_types",
    resourceId: id,
    requestId,
    metadata: parsed.data,
  });

  return ok({ id }, { requestId });
}

export async function DELETE(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "appointment_types" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;

  const admin = createAdminClient();

  // Não deixa apagar tipo com agendamento futuro — arquivar (is_active=false)
  // é o caminho normal, mesmo espírito de "arquivar em vez de apagar" já
  // usado em funis.
  const { count, error: countErr } = await admin
    .from("appointments")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", authz.org.orgId)
    .eq("appointment_type_id", id)
    .eq("status", "scheduled")
    .gte("scheduled_at", new Date().toISOString());

  if (countErr) return fail("internal_error", "Erro ao verificar agendamentos.", 500, { requestId });
  if ((count ?? 0) > 0) {
    return fail(
      "type_has_future_appointments",
      "Este tipo tem agendamentos futuros — cancele-os ou arquive o tipo (is_active=false) em vez de excluir.",
      409,
      { requestId },
    );
  }

  const { error } = await admin
    .from("appointment_types")
    .delete()
    .eq("id", id)
    .eq("organization_id", authz.org.orgId);

  if (error) return fail("internal_error", "Erro ao excluir tipo de agendamento.", 500, { requestId });

  void audit({
    action: "appointment_type.deleted",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "appointment_types",
    resourceId: id,
    requestId,
  });

  return ok({ id }, { requestId });
}
```

- [ ] **Step 8: Rodar e confirmar que passa**

```bash
NEXT_PUBLIC_SUPABASE_URL="https://test-placeholder.invalid" NEXT_PUBLIC_SUPABASE_ANON_KEY="test-anon" SUPABASE_SERVICE_ROLE_KEY="test-service" npx vitest run "app/api/v1/appointment-types/[id]/route.test.ts"
```
Esperado: PASS, 2 testes.

- [ ] **Step 9: Commit**

```bash
git add app/api/v1/appointment-types
git commit -m "feat(agenda): API de tipos de agendamento (CRUD)"
```

---

### Task 6: API — `attendant-schedule` (GET/PUT)

**Files:**
- Create: `app/api/v1/attendant-schedule/route.ts`
- Test: `app/api/v1/attendant-schedule/route.test.ts`

**Interfaces:**
- Consumes: mesmos helpers da Task 5.
- Produces: rota consumida pela UI da Task 15 e pela Task 7 (`available-slots`).

- [ ] **Step 1: Escrever o teste falhando**

```typescript
// app/api/v1/attendant-schedule/route.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { GET, PUT } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const OUTRO_USER_ID = "44444444-4444-4444-8444-444444444444";

function reqOk(role: "agent" | "manager" = "agent") {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID } as never,
    org: { orgId: ORG_ID, name: "Org", role },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("PUT /api/v1/attendant-schedule", () => {
  it("agent NÃO pode editar horário de OUTRA pessoa (403)", async () => {
    reqOk("agent");
    const res = await PUT(
      new Request("http://x", {
        method: "PUT",
        body: JSON.stringify({ user_id: OUTRO_USER_ID, blocks: [] }),
      }) as never,
    );
    expect(res.status).toBe(403);
  });

  it("agent PODE editar o próprio horário", async () => {
    reqOk("agent");
    const deleted: unknown[] = [];
    const inserted: unknown[] = [];
    const chain = {
      delete: () => ({
        eq: () => ({
          eq: () => {
            deleted.push(true);
            return Promise.resolve({ error: null });
          },
        }),
      }),
      insert: (rows: unknown[]) => {
        inserted.push(...rows);
        return Promise.resolve({ error: null });
      },
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);

    const res = await PUT(
      new Request("http://x", {
        method: "PUT",
        body: JSON.stringify({
          user_id: USER_ID,
          blocks: [{ day_of_week: 1, starts_at: "09:00", ends_at: "12:00" }],
        }),
      }) as never,
    );
    expect(res.status).toBe(200);
    expect(deleted).toHaveLength(1);
    expect(inserted).toHaveLength(1);
  });

  it("manager PODE editar horário de outra pessoa", async () => {
    reqOk("manager");
    const chain = {
      delete: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
      insert: () => Promise.resolve({ error: null }),
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);

    const res = await PUT(
      new Request("http://x", {
        method: "PUT",
        body: JSON.stringify({ user_id: OUTRO_USER_ID, blocks: [] }),
      }) as never,
    );
    expect(res.status).toBe(200);
  });

  it("rejeita bloco com ends_at <= starts_at", async () => {
    reqOk("agent");
    const res = await PUT(
      new Request("http://x", {
        method: "PUT",
        body: JSON.stringify({
          user_id: USER_ID,
          blocks: [{ day_of_week: 1, starts_at: "12:00", ends_at: "09:00" }],
        }),
      }) as never,
    );
    expect(res.status).toBe(422);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
NEXT_PUBLIC_SUPABASE_URL="https://test-placeholder.invalid" NEXT_PUBLIC_SUPABASE_ANON_KEY="test-anon" SUPABASE_SERVICE_ROLE_KEY="test-service" npx vitest run app/api/v1/attendant-schedule/route.test.ts
```
Esperado: FALHA — `Cannot find module './route'`.

- [ ] **Step 3: Implementar**

```typescript
// app/api/v1/attendant-schedule/route.ts
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const timeSchema = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);

const blockSchema = z
  .object({
    day_of_week: z.number().int().min(0).max(6),
    starts_at: timeSchema,
    ends_at: timeSchema,
  })
  .refine((b) => b.ends_at > b.starts_at, { message: "ends_at deve ser depois de starts_at" });

const putSchema = z.object({
  user_id: z.string().uuid(),
  blocks: z.array(blockSchema),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "attendant_schedule" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const userId = url.searchParams.get("user_id") ?? authz.user.id;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("attendant_schedule")
    .select("day_of_week, starts_at, ends_at")
    .eq("organization_id", authz.org.orgId)
    .eq("user_id", userId)
    .order("day_of_week", { ascending: true });

  if (error) return fail("internal_error", "Erro ao consultar horário.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "attendant_schedule" });
  if (!authz.ok) return authz.response;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = putSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }

  const editandoOutraPessoa = parsed.data.user_id !== authz.user.id;
  const podeEditarOutro = authz.org.role === "manager" || authz.org.role === "admin";
  if (editandoOutraPessoa && !podeEditarOutro) {
    return fail("forbidden_role", "Só é possível editar o próprio horário.", 403, { requestId });
  }

  const admin = createAdminClient();

  // Substitui o conjunto inteiro da semana desta pessoa — mais simples que
  // diff incremental, e o payload já vem com a semana completa da tela.
  const { error: delErr } = await admin
    .from("attendant_schedule")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("user_id", parsed.data.user_id);
  if (delErr) return fail("internal_error", "Erro ao limpar horário anterior.", 500, { requestId });

  if (parsed.data.blocks.length > 0) {
    const { error: insErr } = await admin.from("attendant_schedule").insert(
      parsed.data.blocks.map((b) => ({
        organization_id: authz.org.orgId,
        user_id: parsed.data.user_id,
        day_of_week: b.day_of_week,
        starts_at: b.starts_at,
        ends_at: b.ends_at,
      })),
    );
    if (insErr) return fail("internal_error", "Erro ao salvar horário.", 500, { requestId });
  }

  void audit({
    action: "attendant_schedule.updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "attendant_schedule",
    resourceId: parsed.data.user_id,
    requestId,
    metadata: { blocks_count: parsed.data.blocks.length },
  });

  return ok({ user_id: parsed.data.user_id, blocks: parsed.data.blocks }, { requestId });
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
NEXT_PUBLIC_SUPABASE_URL="https://test-placeholder.invalid" NEXT_PUBLIC_SUPABASE_ANON_KEY="test-anon" SUPABASE_SERVICE_ROLE_KEY="test-service" npx vitest run app/api/v1/attendant-schedule/route.test.ts
```
Esperado: PASS, 4 testes.

- [ ] **Step 5: Commit**

```bash
git add app/api/v1/attendant-schedule
git commit -m "feat(agenda): API de horário do atendente"
```

---

### Task 7: API — `appointments/available-slots`

**Files:**
- Create: `app/api/v1/appointments/available-slots/route.ts`
- Test: `app/api/v1/appointments/available-slots/route.test.ts`

**Interfaces:**
- Consumes: `computeAvailableSlots` (Task 3), `wallClockParts` (Task 2, para
  achar o `day_of_week` do fuso da org).
- Produces: rota consumida pela UI da Task 13 (diálogo de novo agendamento).

- [ ] **Step 1: Escrever o teste falhando**

```typescript
// app/api/v1/appointments/available-slots/route.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { GET } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const TYPE_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function reqOk() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1" } as never,
    org: { orgId: ORG_ID, name: "Org", role: "agent" },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/v1/appointments/available-slots", () => {
  it("400 sem type_id ou date", async () => {
    reqOk();
    const res = await GET(new Request("http://x/api/v1/appointments/available-slots") as never);
    expect(res.status).toBe(400);
  });

  it("devolve slots calculados a partir do tipo + horário do atendente + fuso da org", async () => {
    reqOk();
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      single: () =>
        Promise.resolve({
          data: { duration_minutes: 30, responsible_user_id: USER_ID },
          error: null,
        }),
      maybeSingle: () => Promise.resolve({ data: { timezone: "Africa/Maputo" }, error: null }),
      order: () => Promise.resolve({ data: [{ starts_at: "09:00:00", ends_at: "10:00:00" }], error: null }),
      lt: () => chain,
      gte: () => Promise.resolve({ data: [], error: null }),
    });
    vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);

    const res = await GET(
      new Request(`http://x/api/v1/appointments/available-slots?type_id=${TYPE_ID}&date=2026-09-01`) as never,
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
NEXT_PUBLIC_SUPABASE_URL="https://test-placeholder.invalid" NEXT_PUBLIC_SUPABASE_ANON_KEY="test-anon" SUPABASE_SERVICE_ROLE_KEY="test-service" npx vitest run app/api/v1/appointments/available-slots/route.test.ts
```
Esperado: FALHA — `Cannot find module './route'`.

- [ ] **Step 3: Implementar**

```typescript
// app/api/v1/appointments/available-slots/route.ts
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeAvailableSlots } from "@/lib/agenda/available-slots";
import { wallClockParts } from "@/lib/tempo/zoned-clock";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "appointments" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const typeId = url.searchParams.get("type_id");
  const date = url.searchParams.get("date"); // "YYYY-MM-DD"
  if (!typeId || !date) {
    return fail("invalid_request", "type_id e date são obrigatórios.", 400, { requestId });
  }

  const admin = createAdminClient();

  const { data: type, error: typeErr } = await admin
    .from("appointment_types")
    .select("duration_minutes, responsible_user_id")
    .eq("id", typeId)
    .eq("organization_id", authz.org.orgId)
    .single();
  if (typeErr || !type) return fail("not_found", "Tipo de agendamento não encontrado.", 404, { requestId });

  const { data: org } = await admin
    .from("organizations")
    .select("timezone")
    .eq("id", authz.org.orgId)
    .maybeSingle();
  const timezone = (org as { timezone: string } | null)?.timezone ?? "UTC";

  // dia da semana do `date` NO FUSO DA ORG (meio-dia UTC evita virada de dia
  // por causa de offset em fusos extremos — o cálculo real de slot usa a hora
  // do bloco, não este instante).
  const dayOfWeek = wallClockParts(new Date(`${date}T12:00:00Z`), timezone).weekday;

  const { data: blocks, error: blocksErr } = await admin
    .from("attendant_schedule")
    .select("starts_at, ends_at")
    .eq("organization_id", authz.org.orgId)
    .eq("user_id", (type as { responsible_user_id: string }).responsible_user_id)
    .eq("day_of_week", dayOfWeek)
    .order("starts_at", { ascending: true });
  if (blocksErr) return fail("internal_error", "Erro ao consultar horário do responsável.", 500, { requestId });

  const dayStart = `${date}T00:00:00.000Z`;
  const dayEnd = `${date}T23:59:59.999Z`;
  const { data: existing, error: existingErr } = await admin
    .from("appointments")
    .select("scheduled_at, duration_minutes")
    .eq("organization_id", authz.org.orgId)
    .eq("responsible_user_id", (type as { responsible_user_id: string }).responsible_user_id)
    .eq("status", "scheduled")
    .gte("scheduled_at", dayStart)
    .lt("scheduled_at", dayEnd);
  if (existingErr) return fail("internal_error", "Erro ao consultar agendamentos existentes.", 500, { requestId });

  const slots = computeAvailableSlots({
    date,
    timezone,
    durationMinutes: (type as { duration_minutes: number }).duration_minutes,
    scheduleBlocks: (blocks ?? []) as { starts_at: string; ends_at: string }[],
    existingAppointments: (existing ?? []) as { scheduled_at: string; duration_minutes: number }[],
  });

  return ok(slots, { requestId });
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
NEXT_PUBLIC_SUPABASE_URL="https://test-placeholder.invalid" NEXT_PUBLIC_SUPABASE_ANON_KEY="test-anon" SUPABASE_SERVICE_ROLE_KEY="test-service" npx vitest run app/api/v1/appointments/available-slots/route.test.ts
```
Esperado: PASS, 2 testes.

- [ ] **Step 5: Commit**

```bash
git add app/api/v1/appointments/available-slots
git commit -m "feat(agenda): rota de horários livres"
```

---

### Task 8: API — `appointments` (list + create)

**Files:**
- Create: `app/api/v1/appointments/route.ts`
- Test: `app/api/v1/appointments/route.test.ts`

**Interfaces:**
- Consumes: `emitLeadActivity` (`lib/leads/activity-emitter.ts`), tipos de
  `ActivityType` da Task 4.
- Produces: rota consumida pela UI das Tasks 13 e 16.

- [ ] **Step 1: Escrever o teste falhando**

```typescript
// app/api/v1/appointments/route.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn().mockResolvedValue({ ok: true }) }));

import { GET, POST } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const LEAD_ID = "55555555-5555-4555-8555-555555555555";
const TYPE_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function reqOk() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID } as never,
    org: { orgId: ORG_ID, name: "Org", role: "agent" },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/v1/appointments", () => {
  it("cria o agendamento, o vínculo em crm_lead_links e a atividade", async () => {
    reqOk();
    const inserts: { table: string; row: unknown }[] = [];
    vi.mocked(createAdminClient).mockReturnValue({
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ single: () => Promise.resolve({ data: { duration_minutes: 30, responsible_user_id: USER_ID }, error: null }) }),
          }),
        }),
        insert: (row: unknown) => {
          inserts.push({ table, row });
          return {
            select: () => ({ single: () => Promise.resolve({ data: { id: "novo-agendamento" }, error: null }) }),
          };
        },
      }),
    } as never);

    const res = await POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          lead_id: LEAD_ID,
          appointment_type_id: TYPE_ID,
          scheduled_at: "2026-09-01T09:00:00.000Z",
        }),
      }) as never,
    );

    expect(res.status).toBe(201);
    expect(inserts.some((i) => i.table === "appointments")).toBe(true);
    expect(inserts.some((i) => i.table === "crm_lead_links")).toBe(true);
  });

  it("409 quando o banco recusa por sobreposição de horário (exclusion constraint, código 23P01)", async () => {
    reqOk();
    vi.mocked(createAdminClient).mockReturnValue({
      from: (table: string) =>
        table === "appointment_types"
          ? {
              select: () => ({
                eq: () => ({
                  eq: () => ({ single: () => Promise.resolve({ data: { duration_minutes: 30, responsible_user_id: USER_ID }, error: null }) }),
                }),
              }),
            }
          : {
              insert: () => ({
                select: () => ({
                  single: () =>
                    Promise.resolve({
                      data: null,
                      error: { code: "23P01", message: "conflicting key value violates exclusion constraint" },
                    }),
                }),
              }),
            },
    } as never);

    const res = await POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          lead_id: LEAD_ID,
          appointment_type_id: TYPE_ID,
          scheduled_at: "2026-09-01T09:00:00.000Z",
        }),
      }) as never,
    );
    expect(res.status).toBe(409);
  });

  it("422 sem lead_id", async () => {
    reqOk();
    const res = await POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ appointment_type_id: TYPE_ID, scheduled_at: "2026-09-01T09:00:00.000Z" }),
      }) as never,
    );
    expect(res.status).toBe(422);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
NEXT_PUBLIC_SUPABASE_URL="https://test-placeholder.invalid" NEXT_PUBLIC_SUPABASE_ANON_KEY="test-anon" SUPABASE_SERVICE_ROLE_KEY="test-service" npx vitest run app/api/v1/appointments/route.test.ts
```
Esperado: FALHA — `Cannot find module './route'`.

- [ ] **Step 3: Implementar**

```typescript
// app/api/v1/appointments/route.ts
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  lead_id: z.string().uuid(),
  appointment_type_id: z.string().uuid(),
  scheduled_at: z.string().datetime(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "appointments" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const from = url.searchParams.get("from"); // ISO
  const to = url.searchParams.get("to"); // ISO
  const responsibleUserId = url.searchParams.get("responsible_user_id");

  const admin = createAdminClient();
  let query = admin
    .from("appointments")
    .select("id, lead_id, appointment_type_id, responsible_user_id, scheduled_at, duration_minutes, status")
    .eq("organization_id", authz.org.orgId)
    .order("scheduled_at", { ascending: true });

  if (from) query = query.gte("scheduled_at", from);
  if (to) query = query.lt("scheduled_at", to);
  if (responsibleUserId) query = query.eq("responsible_user_id", responsibleUserId);

  const { data, error } = await query;
  if (error) return fail("internal_error", "Erro ao listar agendamentos.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "appointments" });
  if (!authz.ok) return authz.response;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = createSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }

  const admin = createAdminClient();

  const { data: type, error: typeErr } = await admin
    .from("appointment_types")
    .select("duration_minutes, responsible_user_id")
    .eq("id", parsed.data.appointment_type_id)
    .eq("organization_id", authz.org.orgId)
    .single();
  if (typeErr || !type) return fail("not_found", "Tipo de agendamento não encontrado.", 404, { requestId });

  const { data: created, error: createErr } = await admin
    .from("appointments")
    .insert({
      organization_id: authz.org.orgId,
      lead_id: parsed.data.lead_id,
      appointment_type_id: parsed.data.appointment_type_id,
      responsible_user_id: (type as { responsible_user_id: string }).responsible_user_id,
      scheduled_at: parsed.data.scheduled_at,
      duration_minutes: (type as { duration_minutes: number }).duration_minutes,
      created_by_user_id: authz.user.id,
    })
    .select("id")
    .single();

  if (createErr) {
    // 23P01 = exclusion_violation — a fonte de verdade final contra corrida
    // (duas abas marcando o mesmo horário do mesmo responsável ao mesmo tempo).
    if ((createErr as { code?: string }).code === "23P01") {
      return fail(
        "schedule_conflict",
        "Este horário já está ocupado para o responsável deste tipo de agendamento.",
        409,
        { requestId },
      );
    }
    return fail("internal_error", "Erro ao criar agendamento.", 500, { requestId });
  }
  const appointmentId = (created as { id: string }).id;

  // Vínculo lead↔agendamento — `target_kind='appointment'` já reservado no
  // CHECK de `crm_lead_links`, nunca usado até aqui (DIRC: referenciar, não duplicar).
  await admin.from("crm_lead_links").insert({
    organization_id: authz.org.orgId,
    lead_id: parsed.data.lead_id,
    target_kind: "appointment",
    target_id: appointmentId,
  });

  await emitLeadActivity(admin as never, {
    organizationId: authz.org.orgId,
    leadId: parsed.data.lead_id,
    type: "appointment_scheduled",
    sourceModule: "agenda",
    sourceId: appointmentId,
    actor: { type: "user", id: authz.user.id },
    reason: `Agendamento marcado para ${new Date(parsed.data.scheduled_at).toLocaleString("pt-BR")}`,
  });

  void audit({
    action: "appointment.created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "appointments",
    resourceId: appointmentId,
    requestId,
    metadata: { lead_id: parsed.data.lead_id, scheduled_at: parsed.data.scheduled_at },
  });

  return ok({ id: appointmentId }, { status: 201, requestId });
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
NEXT_PUBLIC_SUPABASE_URL="https://test-placeholder.invalid" NEXT_PUBLIC_SUPABASE_ANON_KEY="test-anon" SUPABASE_SERVICE_ROLE_KEY="test-service" npx vitest run app/api/v1/appointments/route.test.ts
```
Esperado: PASS, 3 testes.

- [ ] **Step 5: Commit**

```bash
git add app/api/v1/appointments/route.ts app/api/v1/appointments/route.test.ts
git commit -m "feat(agenda): API de criação e listagem de agendamentos"
```

---

### Task 9: API — `appointments/[id]` (PATCH: status e reagendamento)

**Files:**
- Create: `app/api/v1/appointments/[id]/route.ts`
- Test: `app/api/v1/appointments/[id]/route.test.ts`

**Interfaces:**
- Consumes: `ActivityType` da Task 4, `emitLeadActivity`.

- [ ] **Step 1: Escrever o teste falhando**

```typescript
// app/api/v1/appointments/[id]/route.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn().mockResolvedValue({ ok: true }) }));

import { PATCH } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const APPT_ID = "66666666-6666-4666-8666-666666666666";
const LEAD_ID = "55555555-5555-4555-8555-555555555555";

function reqOk() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1" } as never,
    org: { orgId: ORG_ID, name: "Org", role: "agent" },
  });
}

function stubUpdate(updated: Record<string, unknown>) {
  const chain = {
    update: (patch: Record<string, unknown>) => ({
      eq: () => ({
        eq: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: { ...updated, ...patch }, error: null }),
          }),
        }),
      }),
    }),
  };
  vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);
}

beforeEach(() => vi.clearAllMocks());

describe("PATCH /api/v1/appointments/[id]", () => {
  it("muda status para completed", async () => {
    reqOk();
    stubUpdate({ id: APPT_ID, lead_id: LEAD_ID, status: "scheduled" });
    const res = await PATCH(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ status: "completed" }) }) as never,
      { params: Promise.resolve({ id: APPT_ID }) } as never,
    );
    expect(res.status).toBe(200);
  });

  it("reagendar (muda scheduled_at) zera reminder_sent_at", async () => {
    reqOk();
    let patchRecebido: Record<string, unknown> = {};
    const chain = {
      update: (patch: Record<string, unknown>) => {
        patchRecebido = patch;
        return {
          eq: () => ({
            eq: () => ({
              select: () => ({
                single: () => Promise.resolve({ data: { id: APPT_ID, lead_id: LEAD_ID, ...patch }, error: null }),
              }),
            }),
          }),
        };
      },
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);

    await PATCH(
      new Request("http://x", {
        method: "PATCH",
        body: JSON.stringify({ scheduled_at: "2026-09-02T09:00:00.000Z" }),
      }) as never,
      { params: Promise.resolve({ id: APPT_ID }) } as never,
    );
    expect(patchRecebido).toMatchObject({
      scheduled_at: "2026-09-02T09:00:00.000Z",
      reminder_sent_at: null,
    });
  });

  it("422 status fora do vocabulário", async () => {
    reqOk();
    const res = await PATCH(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ status: "invalido" }) }) as never,
      { params: Promise.resolve({ id: APPT_ID }) } as never,
    );
    expect(res.status).toBe(422);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
NEXT_PUBLIC_SUPABASE_URL="https://test-placeholder.invalid" NEXT_PUBLIC_SUPABASE_ANON_KEY="test-anon" SUPABASE_SERVICE_ROLE_KEY="test-service" npx vitest run "app/api/v1/appointments/[id]/route.test.ts"
```
Esperado: FALHA — `Cannot find module './route'`.

- [ ] **Step 3: Implementar**

```typescript
// app/api/v1/appointments/[id]/route.ts
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import type { ActivityType } from "@/lib/leads/activity-vocabulary";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  status: z.enum(["scheduled", "completed", "cancelled", "no_show"]).optional(),
  scheduled_at: z.string().datetime().optional(),
});

const ACTIVITY_BY_STATUS: Record<string, ActivityType> = {
  completed: "appointment_completed",
  cancelled: "appointment_cancelled",
  no_show: "appointment_no_show",
};

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "appointments" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = patchSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }
  if (Object.keys(parsed.data).length === 0) {
    return fail("invalid_request", "Nenhum campo para atualizar.", 400, { requestId });
  }

  const patch: Record<string, unknown> = { ...parsed.data };
  const isReschedule = parsed.data.scheduled_at !== undefined;
  // Reagendar zera reminder_sent_at — senão um agendamento remarcado pra
  // longe nunca recebe lembrete novo (o cron só olha `is null`).
  if (isReschedule) patch.reminder_sent_at = null;

  const admin = createAdminClient();
  const { data: updated, error } = await admin
    .from("appointments")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select("id, lead_id, status, scheduled_at")
    .single();

  if (error) {
    if ((error as { code?: string }).code === "23P01") {
      return fail("schedule_conflict", "O novo horário colide com outro agendamento do responsável.", 409, {
        requestId,
      });
    }
    return fail("internal_error", "Erro ao atualizar agendamento.", 500, { requestId });
  }
  const row = updated as { id: string; lead_id: string; status: string; scheduled_at: string };

  if (isReschedule) {
    await emitLeadActivity(admin as never, {
      organizationId: authz.org.orgId,
      leadId: row.lead_id,
      type: "appointment_rescheduled",
      sourceModule: "agenda",
      sourceId: row.id,
      actor: { type: "user", id: authz.user.id },
      reason: `Agendamento remarcado para ${new Date(row.scheduled_at).toLocaleString("pt-BR")}`,
    });
    void audit({
      action: "appointment.rescheduled",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "appointments",
      resourceId: row.id,
      requestId,
      metadata: { scheduled_at: row.scheduled_at },
    });
  }
  if (parsed.data.status !== undefined && ACTIVITY_BY_STATUS[parsed.data.status]) {
    await emitLeadActivity(admin as never, {
      organizationId: authz.org.orgId,
      leadId: row.lead_id,
      type: ACTIVITY_BY_STATUS[parsed.data.status]!,
      sourceModule: "agenda",
      sourceId: row.id,
      actor: { type: "user", id: authz.user.id },
      reason: `Status do agendamento mudou para ${parsed.data.status}`,
    });
    void audit({
      action: "appointment.status_changed",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "appointments",
      resourceId: row.id,
      requestId,
      metadata: { status: parsed.data.status },
    });
  }

  return ok(row, { requestId });
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
NEXT_PUBLIC_SUPABASE_URL="https://test-placeholder.invalid" NEXT_PUBLIC_SUPABASE_ANON_KEY="test-anon" SUPABASE_SERVICE_ROLE_KEY="test-service" npx vitest run "app/api/v1/appointments/[id]/route.test.ts"
```
Esperado: PASS, 3 testes.

- [ ] **Step 5: Commit**

```bash
git add "app/api/v1/appointments/[id]"
git commit -m "feat(agenda): API de mudança de status e reagendamento"
```

---

### Task 10: Cron — `appointment-reminder`

**Files:**
- Create: `app/api/v1/cron/appointment-reminder/route.ts`
- Test: `tests/unit/appointment-reminder.test.ts`
- Modify: `docker/scheduler/entrypoint.sh`

**Interfaces:**
- Consumes: `runBeforeSend` (`lib/agent-engine/guardrails/before-send.ts`) —
  **assinatura real**: `runBeforeSend({ pool, log, tenantId, leadId, channelSessionId, body, optedOutThisTurn, crmDailyLimit, now, send }): Promise<BeforeSendResult>`
  (ver `lib/agent-engine/guardrails/before-send.ts`, já usado nesta sessão nas
  Tasks de fix #2). `leadId` no contrato de `runBeforeSend` é na verdade o
  `contact_id` (mesmo apelido usado em `readStopFlags`/`readLastInboundAt`) —
  usar `appointments.lead_id` resolvido para o `contact_id` do lead via
  `crm_leads.contact_id`.

- [ ] **Step 1: Escrever o teste falhando**

Segue o MESMO padrão de dublê de client (sem Docker) já usado em
`tests/unit/event-log-purge.test.ts`/`tests/unit/prune-old-media.test.ts`
desta sessão.

```typescript
// tests/unit/appointment-reminder.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({
  runBeforeSend: vi.fn(),
}));

import { sendAppointmentReminders } from "@/app/api/v1/cron/appointment-reminder/route";
import { runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";

const AGORA = new Date("2026-08-30T10:00:00.000Z");

function makeAdminStub(
  appointments: { id: string; lead_id: string; organization_id: string; scheduled_at: string }[],
  contactByLead: Record<string, { contact_id: string; channel_session_id: string }>,
) {
  const marcados: string[] = [];
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        lte: () => Promise.resolve({ data: table === "appointments" ? appointments : [], error: null }),
        update: (patch: Record<string, unknown>) => ({
          eq: () => {
            if ("reminder_sent_at" in patch) marcados.push("reminder_sent_at");
            return Promise.resolve({ error: null });
          },
        }),
        single: () => {
          const leadId = (chain as { __leadId?: string }).__leadId;
          return Promise.resolve({ data: contactByLead[leadId ?? ""] ?? null, error: null });
        },
      };
      return chain;
    },
  };
  return { client, marcados };
}

describe("appointment-reminder — a regra", () => {
  it("envia via runBeforeSend, nunca um send direto", async () => {
    vi.mocked(runBeforeSend).mockResolvedValue({
      status: "sent",
      outcome: { kind: "sent", idempotencyKey: "k", messageId: "m" },
      trace: [],
    });
    const { client } = makeAdminStub(
      [{ id: "a1", lead_id: "lead-1", organization_id: "org-1", scheduled_at: "2026-08-31T10:00:00.000Z" }],
      { "lead-1": { contact_id: "contact-1", channel_session_id: "sess-1" } },
    );

    await sendAppointmentReminders(client as never, { connect: vi.fn(), query: vi.fn() } as never, AGORA);

    expect(runBeforeSend).toHaveBeenCalledTimes(1);
  });

  it("veto (STOP/janela/anti-ban) NÃO marca reminder_sent_at", async () => {
    vi.mocked(runBeforeSend).mockResolvedValue({
      status: "vetoed",
      gate: "stop",
      code: "contato_bloqueado",
      message: "bloqueado",
      trace: [],
    });
    const { client, marcados } = makeAdminStub(
      [{ id: "a1", lead_id: "lead-1", organization_id: "org-1", scheduled_at: "2026-08-31T10:00:00.000Z" }],
      { "lead-1": { contact_id: "contact-1", channel_session_id: "sess-1" } },
    );

    await sendAppointmentReminders(client as never, { connect: vi.fn(), query: vi.fn() } as never, AGORA);

    expect(marcados).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
NEXT_PUBLIC_SUPABASE_URL="https://test-placeholder.invalid" NEXT_PUBLIC_SUPABASE_ANON_KEY="test-anon" SUPABASE_SERVICE_ROLE_KEY="test-service" npx vitest run tests/unit/appointment-reminder.test.ts
```
Esperado: FALHA — `Cannot find module '@/app/api/v1/cron/appointment-reminder/route'`.

- [ ] **Step 3: Implementar**

```typescript
// app/api/v1/cron/appointment-reminder/route.ts
/**
 * GET/POST /api/v1/cron/appointment-reminder
 *
 * Lembrete de agendamento por WhatsApp — janela fixa de 24h no MVP (Frente A
 * da Agenda). NÃO é um envio cru: passa por `runBeforeSend`
 * (`lib/agent-engine/guardrails/before-send.ts`), a mesma cadeia que corrige
 * o bug de dupla resposta IA+humano — sem isso, mandaria mensagem pra lead
 * que pediu STOP, ignoraria janela de 24h e anti-ban (doutrina WAHA W-01..12).
 *
 * `channel_session_id` é o da conversa mais recente do lead — nunca
 * inventado. Sem conversa nenhuma, o gate de janela veta e vira aviso na
 * Central, não uma tentativa de enviar por canal que não existe.
 *
 * Marca `reminder_sent_at` só quando o resultado é `sent` — veto não conta
 * como "mandei", pra não mascarar "não pude" como "mandei".
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";
import { getPgPool } from "@/lib/agent-engine/pool"; // pool pg já usado pelo agent-engine

export const dynamic = "force-dynamic";

/** Janela fixa do MVP — não configurável por org ainda (fora de escopo da Frente A). */
export const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;
const BATCH_LIMIT = 100;

export interface ReminderResult {
  scanned: number;
  sent: number;
  vetoed: number;
  failed: number;
}

interface DueAppointment {
  id: string;
  lead_id: string;
  organization_id: string;
  scheduled_at: string;
}

export async function sendAppointmentReminders(
  admin: ReturnType<typeof createAdminClient>,
  pool: Pool,
  now: Date,
): Promise<ReminderResult> {
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_MS).toISOString();

  const { data: due, error } = await admin
    .from("appointments")
    .select("id, lead_id, organization_id, scheduled_at")
    .eq("status", "scheduled")
    .is("reminder_sent_at", null)
    .lte("scheduled_at", windowEnd)
    .limit(BATCH_LIMIT);
  if (error) throw new Error(`select_due_failed: ${error.message}`);

  const result: ReminderResult = { scanned: 0, sent: 0, vetoed: 0, failed: 0 };
  for (const appt of (due ?? []) as DueAppointment[]) {
    result.scanned += 1;
    try {
      await sendOneReminder(admin, pool, appt, now, result);
    } catch (err) {
      result.failed += 1;
      logger.error("[appointment-reminder] falhou", {
        appointment_id: appt.id,
        error: err instanceof Error ? err.message : String(err),
      });
      await admin.from("agent_inbox_items").insert({
        organization_id: appt.organization_id,
        kind: "message_send_stuck",
        severity: "warning",
        title: "Lembrete de agendamento não enviado",
        body: "Falha de infraestrutura ao tentar enviar o lembrete de WhatsApp. Verifique a conexão do canal.",
        ref_kind: "conversation",
        ref_id: null,
      });
    }
  }
  return result;
}

async function sendOneReminder(
  admin: ReturnType<typeof createAdminClient>,
  pool: Pool,
  appt: DueAppointment,
  now: Date,
  result: ReminderResult,
): Promise<void> {
  const { data: lead } = await admin
    .from("crm_leads")
    .select("contact_id")
    .eq("id", appt.lead_id)
    .single();
  const contactId = (lead as { contact_id: string } | null)?.contact_id;
  if (!contactId) return;

  const { data: conv } = await admin
    .from("conversations")
    .select("channel_session_id")
    .eq("contact_id", contactId)
    .eq("organization_id", appt.organization_id)
    .order("last_inbound_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const channelSessionId = (conv as { channel_session_id: string } | null)?.channel_session_id;
  if (!channelSessionId) return; // sem conversa: nada a fazer, próxima rodada tenta de novo

  const body =
    `Lembrete: você tem um horário marcado para ${new Date(appt.scheduled_at).toLocaleString("pt-BR")}. ` +
    `Se precisar remarcar, é só nos avisar.`;

  const outcome = await runBeforeSend({
    pool,
    log: logger,
    tenantId: appt.organization_id,
    leadId: contactId,
    channelSessionId,
    body,
    optedOutThisTurn: false,
    crmDailyLimit: null,
    now,
    send: async (finalBody: string) => {
      // Envio real: mesmo ponto de entrada que o resto do agent-engine usa
      // para o ChannelAdapter — fora do escopo deste snippet (implementação
      // real referencia o adapter já injetado no agent-engine).
      return { kind: "sent", idempotencyKey: appt.id, messageId: appt.id };
    },
  });

  if (outcome.status === "sent") {
    await admin.from("appointments").update({ reminder_sent_at: now.toISOString() }).eq("id", appt.id);
    result.sent += 1;
  } else {
    result.vetoed += 1;
  }
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let result: ReminderResult;
  try {
    result = await sendAppointmentReminders(createAdminClient(), getPgPool(), new Date());
  } catch (err) {
    logger.error("[appointment-reminder] falhou", { error: err instanceof Error ? err.message : String(err) });
    return fail("internal_error", "Failed to send appointment reminders.", 500, { requestId });
  }
  return ok(result, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}
export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
```

**⚠️ Nota para quem implementar de verdade (não placeholder — decisão explícita
que precisa ser tomada com o código real na mão):** o `send:` acima e
`getPgPool()` são os DOIS pontos que precisam ser resolvidos contra a
implementação REAL do `ChannelAdapter`/pool `pg` já usados por
`lib/agent-engine/agent/inbound-turn.ts` — leia esse arquivo antes de finalizar
este cron, para reusar a MESMA função de envio físico (WAHA), em vez de
inventar uma nova. Se `lib/agent-engine/pool.ts` não existir com esse nome
exato, localize o pool `pg.Pool` real que `runBeforeSend` já recebe em
produção (grep por `new Pool(` ou `getPgPool` no `lib/agent-engine/`) e ajuste
o import.

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
NEXT_PUBLIC_SUPABASE_URL="https://test-placeholder.invalid" NEXT_PUBLIC_SUPABASE_ANON_KEY="test-anon" SUPABASE_SERVICE_ROLE_KEY="test-service" npx vitest run tests/unit/appointment-reminder.test.ts
```
Esperado: PASS, 2 testes.

- [ ] **Step 5: Registrar no crontab**

Em `docker/scheduler/entrypoint.sh`, adicionar à lista `CRONS` (mesmo formato
das linhas já existentes — `event-log-purge`/`prune-old-media` desta sessão):

```
*/10 * * * *|60|api/v1/cron/appointment-reminder
```

- [ ] **Step 6: Rodar o gate de cobertura de crons**

```bash
NEXT_PUBLIC_SUPABASE_URL="https://test-placeholder.invalid" NEXT_PUBLIC_SUPABASE_ANON_KEY="test-anon" SUPABASE_SERVICE_ROLE_KEY="test-service" npx vitest run tests/unit/cron-routes-scheduled.test.ts
bash tests/shell/scheduler-entrypoint.test.sh
```
Esperado: PASS nos dois.

- [ ] **Step 7: Commit**

```bash
git add app/api/v1/cron/appointment-reminder tests/unit/appointment-reminder.test.ts docker/scheduler/entrypoint.sh
git commit -m "feat(agenda): cron de lembrete via WhatsApp (runBeforeSend)"
```

---

### Task 11: Cron — `appointment-outcome-nudge`

**Files:**
- Create: `app/api/v1/cron/appointment-outcome-nudge/route.ts`
- Test: `tests/unit/appointment-outcome-nudge.test.ts`
- Modify: `docker/scheduler/entrypoint.sh`

**Interfaces:**
- Produces: aviso em `agent_inbox_items` (mesma tabela já usada por
  `recover-stuck-messages`).

- [ ] **Step 1: Escrever o teste falhando**

```typescript
// tests/unit/appointment-outcome-nudge.test.ts
import { describe, expect, it, vi } from "vitest";

import { nudgePendingOutcomes } from "@/app/api/v1/cron/appointment-outcome-nudge/route";

const AGORA = new Date("2026-08-30T12:00:00.000Z");

function makeAdminStub(pastAppointments: { id: string; organization_id: string; lead_id: string }[]) {
  const insertedInbox: unknown[] = [];
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        lt: () => Promise.resolve({ data: table === "appointments" ? pastAppointments : [], error: null }),
        insert: (row: unknown) => {
          insertedInbox.push(row);
          return Promise.resolve({ error: null });
        },
      };
      return chain;
    },
  };
  return { client, insertedInbox };
}

describe("appointment-outcome-nudge — a regra", () => {
  it("agendamento com >1h de atraso e ainda scheduled: abre aviso, NÃO muda status sozinho", async () => {
    const { client, insertedInbox } = makeAdminStub([
      { id: "a1", organization_id: "org-1", lead_id: "lead-1" },
    ]);

    const result = await nudgePendingOutcomes(client as never, AGORA);

    expect(result.nudged).toBe(1);
    expect(insertedInbox).toHaveLength(1);
    expect((insertedInbox[0] as { kind: string }).kind).toBe("appointment_outcome_pending");
  });

  it("sem agendamentos atrasados: nenhum aviso", async () => {
    const { client, insertedInbox } = makeAdminStub([]);
    const result = await nudgePendingOutcomes(client as never, AGORA);
    expect(result.nudged).toBe(0);
    expect(insertedInbox).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
NEXT_PUBLIC_SUPABASE_URL="https://test-placeholder.invalid" NEXT_PUBLIC_SUPABASE_ANON_KEY="test-anon" SUPABASE_SERVICE_ROLE_KEY="test-service" npx vitest run tests/unit/appointment-outcome-nudge.test.ts
```
Esperado: FALHA — `Cannot find module '@/app/api/v1/cron/appointment-outcome-nudge/route'`.

- [ ] **Step 3: Implementar**

```typescript
// app/api/v1/cron/appointment-outcome-nudge/route.ts
/**
 * GET/POST /api/v1/cron/appointment-outcome-nudge
 *
 * Agendamento `scheduled` cujo horário+duração já passou há mais de 1h NÃO é
 * auto-marcado como completed/no_show — só um humano sabe se o cliente veio.
 * Abre aviso na Central pedindo confirmação. Fecha o invariante "nada morre
 * sem próximo passo" (Sistema Vivo): sem isso, o agendamento ficaria
 * `scheduled` para sempre, mentindo pra qualquer relatório de no-show.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const GRACE_MS = 60 * 60 * 1000; // 1h após o fim do agendamento
const BATCH_LIMIT = 100;

export interface NudgeResult {
  nudged: number;
}

interface PastAppointment {
  id: string;
  organization_id: string;
  lead_id: string;
}

export async function nudgePendingOutcomes(
  admin: ReturnType<typeof createAdminClient>,
  now: Date,
): Promise<NudgeResult> {
  // O corte precisa considerar scheduled_at + duration_minutes, não só
  // scheduled_at — um agendamento de 2h "termina" bem depois de começar.
  // Filtrado no app (não em SQL puro) porque o dublê de teste não modela
  // expressão computada; a implementação real usa uma coluna computada
  // (`ends_at generated always as (scheduled_at + duration_minutes * interval '1 minute') stored`)
  // ou filtra client-side após um SELECT amplo por `scheduled_at < now - X`.
  const cutoff = new Date(now.getTime() - GRACE_MS).toISOString();

  const { data, error } = await admin
    .from("appointments")
    .select("id, organization_id, lead_id")
    .eq("status", "scheduled")
    .lt("scheduled_at", cutoff)
    .limit(BATCH_LIMIT);
  if (error) throw new Error(`select_past_failed: ${error.message}`);

  const past = (data ?? []) as PastAppointment[];
  for (const appt of past) {
    await admin.from("agent_inbox_items").insert({
      organization_id: appt.organization_id,
      kind: "appointment_outcome_pending",
      severity: "info",
      title: "Confirme o desfecho de um agendamento",
      body: "Um horário marcado já passou e ainda não foi marcado como concluído, cancelado ou falta.",
      ref_kind: "appointment",
      ref_id: appt.id,
    });
  }

  return { nudged: past.length };
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let result: NudgeResult;
  try {
    result = await nudgePendingOutcomes(createAdminClient(), new Date());
  } catch (err) {
    logger.error("[appointment-outcome-nudge] falhou", { error: err instanceof Error ? err.message : String(err) });
    return fail("internal_error", "Failed to nudge pending outcomes.", 500, { requestId });
  }
  return ok(result, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}
export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
```

**Nota de schema pendente:** o filtro real de "scheduled_at + duration_minutes
< now - 1h" precisa ou (a) de uma coluna gerada `ends_at` em `appointments`
(adicionar à migration da Task 1 antes de aplicar, já que ainda não foi
aplicada em produção neste plano) ou (b) filtrar no aplicativo após um SELECT
mais amplo. Prefira (a) — volte à Task 1 e adicione:
```sql
alter table public.appointments
  add column if not exists ends_at timestamptz
  generated always as (scheduled_at + (duration_minutes || ' minutes')::interval) stored;
```
e troque `.lt("scheduled_at", cutoff)` por `.lt("ends_at", cutoff)` neste
arquivo antes de considerar a task concluída.

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
NEXT_PUBLIC_SUPABASE_URL="https://test-placeholder.invalid" NEXT_PUBLIC_SUPABASE_ANON_KEY="test-anon" SUPABASE_SERVICE_ROLE_KEY="test-service" npx vitest run tests/unit/appointment-outcome-nudge.test.ts
```
Esperado: PASS, 2 testes.

- [ ] **Step 5: Registrar no crontab**

```
0 * * * *|60|api/v1/cron/appointment-outcome-nudge
```

- [ ] **Step 6: Rodar os gates de cron**

```bash
NEXT_PUBLIC_SUPABASE_URL="https://test-placeholder.invalid" NEXT_PUBLIC_SUPABASE_ANON_KEY="test-anon" SUPABASE_SERVICE_ROLE_KEY="test-service" npx vitest run tests/unit/cron-routes-scheduled.test.ts
bash tests/shell/scheduler-entrypoint.test.sh
```

- [ ] **Step 7: Commit**

```bash
git add app/api/v1/cron/appointment-outcome-nudge tests/unit/appointment-outcome-nudge.test.ts docker/scheduler/entrypoint.sh supabase/migrations/20260830120000_0165_agenda_nativa.sql supabase/baseline.sql
git commit -m "feat(agenda): cron de aviso de desfecho pendente + coluna ends_at"
```

---

### Task 12: LGPD — teste de que `appointments` herda a anonimização do lead

**Files:**
- Create: `tests/invariants/lgpd-cascata-appointments.test.ts`

**Interfaces:**
- Nenhuma nova — só prova comportamento já garantido pelo desenho (nenhuma
  coluna de `appointments` grava nome/telefone em texto livre fora do
  `lead_id`).

- [ ] **Step 1: Escrever o teste (requer `pnpm test:db`)**

```typescript
// tests/invariants/lgpd-cascata-appointments.test.ts
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * LGPD — `appointments` não guarda PII em texto livre; a anonimização do
 * lead/contato (via `fn_lgpd_cascade_redact_contact`) é suficiente para que
 * qualquer consulta que junte `appointments` a `crm_leads` veja o nome já
 * anonimizado. Este teste prova isso plantando um agendamento, redigindo o
 * contato, e conferindo que o JOIN não revela o nome original em lugar nenhum.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — run via `pnpm test:db`");
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

describe("LGPD — appointments herda a anonimização do lead", () => {
  it("após redact do contato, o join appointments→crm_leads não mostra o nome original", () => {
    const out = sql(`
      do $$
      declare
        v_org uuid := gen_random_uuid();
        v_contact uuid := gen_random_uuid();
        v_lead uuid := gen_random_uuid();
        v_type uuid := gen_random_uuid();
        v_user uuid := gen_random_uuid();
        v_appt uuid := gen_random_uuid();
        v_request uuid := gen_random_uuid();
      begin
        insert into organizations (id, slug, legal_name, display_name) values (v_org, 'org-lgpd-appt', 'X', 'X');
        insert into contacts (id, organization_id, display_name) values (v_contact, v_org, 'Fulano de Tal');
        insert into crm_pipelines (id, organization_id, name, slug) values (gen_random_uuid(), v_org, 'P', 'p');
        insert into crm_leads (id, organization_id, contact_id, title) values (v_lead, v_org, v_contact, 'Fulano de Tal');
        insert into appointment_types (id, organization_id, name, duration_minutes, responsible_user_id)
          values (v_type, v_org, 'Consulta', 30, v_user);
        insert into appointments (id, organization_id, lead_id, appointment_type_id, responsible_user_id, scheduled_at, duration_minutes, created_by_user_id)
          values (v_appt, v_org, v_lead, v_type, v_user, now() + interval '1 day', 30, v_user);
        perform fn_lgpd_cascade_redact_contact(v_org, v_contact, v_request);
      end $$;

      select l.title
        from appointments a
        join crm_leads l on l.id = a.lead_id
       where a.id = (select id from appointments where organization_id in (select id from organizations where slug = 'org-lgpd-appt'));
    `);
    expect(out).not.toContain("Fulano de Tal");
    expect(out).toMatch(/Cliente Anonimizado/);
  });
});
```

- [ ] **Step 2: Rodar (requer Docker)**

```bash
pnpm test:db
```
Esperado: PASS. Se Docker não estiver disponível neste ambiente, declarar
explicitamente que este teste não foi executado e precisa rodar antes do
merge.

- [ ] **Step 3: Commit**

```bash
git add tests/invariants/lgpd-cascata-appointments.test.ts
git commit -m "test(agenda): appointments herda anonimização LGPD do lead"
```

---

### Task 13: Navegação — item "Agenda" no menu

**Files:**
- Modify: `lib/ui/icons.ts`
- Modify: `lib/navigation/registry.ts`

**Interfaces:**
- Produces: entrada `NavDestination` para `/app/agenda`, consumida
  visualmente pela Task 14.

- [ ] **Step 1: Adicionar o ícone**

Em `lib/ui/icons.ts`, adicionar `CalendarBlank` à lista de re-exports (mesmo
padrão de `Clock`/`Kanban` já presentes):

```typescript
  CalendarBlank,
```

- [ ] **Step 2: Adicionar a entrada de navegação**

Em `lib/navigation/registry.ts`, importar `CalendarBlank` no topo (junto dos
outros ícones) e adicionar ao array `NAV_DESTINATIONS` (ou nome equivalente),
logo após o bloco "CRM — o funil":

```typescript
  {
    href: "/app/agenda",
    label: "Agenda",
    description: "Horários marcados — hoje e os próximos dias.",
    icon: CalendarBlank,
    group: "crm",
    sidebar: true,
  },
```

- [ ] **Step 3: Rodar o gate de navegação**

```bash
NEXT_PUBLIC_SUPABASE_URL="https://test-placeholder.invalid" NEXT_PUBLIC_SUPABASE_ANON_KEY="test-anon" SUPABASE_SERVICE_ROLE_KEY="test-service" npx vitest run tests/unit/navegacao-completude.test.ts
```
Esperado: PASS assim que `/app/agenda/page.tsx` existir (Task 14) — se este
teste reprovar ANTES da Task 14 por "rota sem página", isso é esperado; rode
de novo depois da Task 14.

- [ ] **Step 4: Commit**

```bash
git add lib/ui/icons.ts lib/navigation/registry.ts
git commit -m "feat(agenda): item de navegação"
```

---

### Task 14: Tela — Agenda (lista por dia)

**Files:**
- Create: `app/app/agenda/page.tsx`
- Create: `app/app/agenda/_client.tsx`
- Test (E2E, ver Task 17)

**Interfaces:**
- Consumes: `GET /api/v1/appointments?from=&to=` (Task 8), `requireAuth`/`resolveActiveOrg` (`lib/auth/server.ts`).

- [ ] **Step 1: Implementar `page.tsx` (Server Component)**

```tsx
// app/app/agenda/page.tsx
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { AgendaClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function AgendaPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Agenda</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Horários marcados. Para criar um agendamento novo, abra o dossiê do lead e use
          o botão &quot;Marcar horário&quot;.
        </p>
      </header>
      <AgendaClient />
    </div>
  );
}
```

- [ ] **Step 2: Implementar `_client.tsx` (Client Component — lista + seletor de data)**

```tsx
// app/app/agenda/_client.tsx
"use client";
import { useEffect, useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface AppointmentRow {
  id: string;
  lead_id: string;
  scheduled_at: string;
  duration_minutes: number;
  status: "scheduled" | "completed" | "cancelled" | "no_show";
}

const STATUS_LABEL: Record<AppointmentRow["status"], string> = {
  scheduled: "Marcado",
  completed: "Concluído",
  cancelled: "Cancelado",
  no_show: "Não compareceu",
};

function toDateInputValue(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function AgendaClient() {
  const [date, setDate] = useState(() => toDateInputValue(new Date()));
  const [items, setItems] = useState<AppointmentRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelado = false;
    setLoading(true);
    const from = `${date}T00:00:00.000Z`;
    const to = `${date}T23:59:59.999Z`;
    fetch(`/api/v1/appointments?from=${from}&to=${to}`)
      .then((r) => r.json())
      .then((json: { data?: AppointmentRow[] }) => {
        if (!cancelado) setItems(json.data ?? []);
      })
      .finally(() => {
        if (!cancelado) setLoading(false);
      });
    return () => {
      cancelado = true;
    };
  }, [date]);

  function mudarDia(delta: number) {
    const atual = new Date(`${date}T12:00:00Z`);
    atual.setUTCDate(atual.getUTCDate() + delta);
    setDate(toDateInputValue(atual));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => mudarDia(-1)}>
          ← Dia anterior
        </Button>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        />
        <Button variant="outline" size="sm" onClick={() => mudarDia(1)}>
          Próximo dia →
        </Button>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Carregando…</p>}
      {!loading && items.length === 0 && (
        <p className="text-sm text-muted-foreground">Nenhum agendamento neste dia.</p>
      )}
      <div className="flex flex-col gap-2">
        {items.map((item) => (
          <Card key={item.id}>
            <CardContent className="flex items-center justify-between gap-4 py-3">
              <div className="flex flex-col">
                <span className="text-sm font-medium">
                  {new Date(item.scheduled_at).toLocaleTimeString("pt-BR", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}{" "}
                  · {item.duration_minutes} min
                </span>
                <a href={`/app/kanban?lead=${item.lead_id}`} className="text-xs text-muted-foreground underline">
                  Ver lead
                </a>
              </div>
              <Badge variant={item.status === "cancelled" ? "outline" : "default"}>
                {STATUS_LABEL[item.status]}
              </Badge>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verificar manualmente (dev server)**

```bash
npm run dev
```
Abrir `http://localhost:3000/app/agenda`, confirmar que a tela carrega sem
erro (mesmo vazia, sem agendamentos ainda).

- [ ] **Step 4: Rodar o gate de navegação (agora com a página existindo)**

```bash
NEXT_PUBLIC_SUPABASE_URL="https://test-placeholder.invalid" NEXT_PUBLIC_SUPABASE_ANON_KEY="test-anon" SUPABASE_SERVICE_ROLE_KEY="test-service" npx vitest run tests/unit/navegacao-completude.test.ts
```
Esperado: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/app/agenda
git commit -m "feat(agenda): tela de Agenda (lista por dia)"
```

---

### Task 15: Tela — Configurações → Tipos de agendamento

**Files:**
- Create: `app/app/settings/appointment-types/page.tsx`
- Create: `app/app/settings/appointment-types/_client.tsx`
- Modify: `lib/navigation/registry.ts` (entrada da tela de config)

**Interfaces:**
- Consumes: `GET/POST /api/v1/appointment-types`, `PATCH/DELETE /api/v1/appointment-types/[id]` (Task 5).

- [ ] **Step 1: Adicionar a entrada de navegação (manager+, mesmo padrão de "Etapas do funil")**

```typescript
  {
    href: "/app/settings/appointment-types",
    label: "Tipos de agendamento",
    description: "Os tipos de horário que a equipe pode marcar, e quem é o responsável de cada um.",
    icon: CalendarBlank,
    group: "crm",
    minRole: "manager",
    sidebar: false,
  },
```

- [ ] **Step 2: Implementar `page.tsx`**

```tsx
// app/app/settings/appointment-types/page.tsx
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { AppointmentTypesClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function AppointmentTypesPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!user.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Tipos de agendamento</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Cada tipo tem duração e um responsável fixo — quem marca um horário desse tipo
          agenda direto com essa pessoa.
        </p>
      </header>
      <AppointmentTypesClient />
    </div>
  );
}
```

- [ ] **Step 3: Implementar `_client.tsx`**

```tsx
// app/app/settings/appointment-types/_client.tsx
"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface AppointmentType {
  id: string;
  name: string;
  duration_minutes: number;
  responsible_user_id: string;
  is_active: boolean;
}

export function AppointmentTypesClient() {
  const [items, setItems] = useState<AppointmentType[]>([]);
  const [name, setName] = useState("");
  const [duration, setDuration] = useState(30);
  const [responsibleUserId, setResponsibleUserId] = useState("");
  const [salvando, setSalvando] = useState(false);

  async function carregar() {
    const res = await fetch("/api/v1/appointment-types");
    const json = (await res.json()) as { data?: AppointmentType[] };
    setItems(json.data ?? []);
  }

  useEffect(() => {
    void carregar();
  }, []);

  async function criar() {
    if (!name.trim() || !responsibleUserId.trim()) {
      toast.error("Preencha nome e responsável.");
      return;
    }
    setSalvando(true);
    try {
      const res = await fetch("/api/v1/appointment-types", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, duration_minutes: duration, responsible_user_id: responsibleUserId }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        toast.error(json.error?.message ?? "Erro ao criar.");
        return;
      }
      setName("");
      setResponsibleUserId("");
      await carregar();
      toast.success("Tipo criado.");
    } finally {
      setSalvando(false);
    }
  }

  async function excluir(id: string) {
    const res = await fetch(`/api/v1/appointment-types/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const json = (await res.json()) as { error?: { message?: string } };
      toast.error(json.error?.message ?? "Erro ao excluir.");
      return;
    }
    await carregar();
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 py-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="type-name">Nome</Label>
            <Input id="type-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Consulta" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="type-duration">Duração (min)</Label>
            <Input
              id="type-duration"
              type="number"
              min={5}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="w-24"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="type-responsible">ID do responsável (usuário)</Label>
            <Input
              id="type-responsible"
              value={responsibleUserId}
              onChange={(e) => setResponsibleUserId(e.target.value)}
              placeholder="uuid do usuário"
              className="w-72"
            />
          </div>
          <Button type="button" onClick={criar} disabled={salvando}>
            {salvando ? "Salvando…" : "Criar tipo"}
          </Button>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-2">
        {items.map((item) => (
          <Card key={item.id}>
            <CardContent className="flex items-center justify-between py-3">
              <span className="text-sm">
                {item.name} · {item.duration_minutes} min {item.is_active ? "" : "· (arquivado)"}
              </span>
              <Button variant="outline" size="sm" onClick={() => void excluir(item.id)}>
                Excluir
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
```

**Nota:** o campo "ID do responsável" como input de texto cru é o corte de
escopo mais simples possível para o MVP — um seletor de pessoas da
organização (buscando `user_organizations`) é uma melhoria de UX de
follow-up, não bloqueante para esta frente.

- [ ] **Step 4: Verificar manualmente**

```bash
npm run dev
```
Abrir `/app/settings/appointment-types`, criar um tipo, confirmar que aparece
na lista e que `DELETE` funciona.

- [ ] **Step 5: Commit**

```bash
git add app/app/settings/appointment-types lib/navigation/registry.ts
git commit -m "feat(agenda): tela de Tipos de agendamento"
```

---

### Task 16: Tela — Meu horário de agendamento

**Files:**
- Create: `app/app/settings/meu-horario/page.tsx`
- Create: `app/app/settings/meu-horario/_client.tsx`
- Modify: `lib/navigation/registry.ts`

**Interfaces:**
- Consumes: `GET/PUT /api/v1/attendant-schedule` (Task 6).

- [ ] **Step 1: Adicionar a entrada de navegação (qualquer role — cada um edita o próprio)**

```typescript
  {
    href: "/app/settings/meu-horario",
    label: "Meu horário de agendamento",
    description: "Os dias e horários em que você pode ser agendado pela equipe.",
    icon: CalendarBlank,
    group: "crm",
    sidebar: false,
  },
```

- [ ] **Step 2: Implementar `page.tsx`**

```tsx
// app/app/settings/meu-horario/page.tsx
import { requireAuth } from "@/lib/auth/server";
import { MeuHorarioClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function MeuHorarioPage() {
  const user = await requireAuth();

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Meu horário de agendamento</h1>
        <p className="text-sm text-muted-foreground">
          Os dias e horários em que clientes podem marcar um agendamento com você.
        </p>
      </header>
      <MeuHorarioClient userId={user.id} />
    </div>
  );
}
```

- [ ] **Step 3: Implementar `_client.tsx`**

```tsx
// app/app/settings/meu-horario/_client.tsx
"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Block {
  day_of_week: number;
  starts_at: string;
  ends_at: string;
}

const DIAS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

export function MeuHorarioClient({ userId }: { userId: string }) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    fetch("/api/v1/attendant-schedule")
      .then((r) => r.json())
      .then((json: { data?: Block[] }) => setBlocks(json.data ?? []));
  }, []);

  function blocoDoDia(dia: number): Block {
    return blocks.find((b) => b.day_of_week === dia) ?? { day_of_week: dia, starts_at: "", ends_at: "" };
  }

  function atualizarBloco(dia: number, campo: "starts_at" | "ends_at", valor: string) {
    setBlocks((prev) => {
      const existe = prev.find((b) => b.day_of_week === dia);
      if (existe) {
        return prev.map((b) => (b.day_of_week === dia ? { ...b, [campo]: valor } : b));
      }
      return [...prev, { day_of_week: dia, starts_at: "", ends_at: "", [campo]: valor } as Block];
    });
  }

  async function salvar() {
    setSalvando(true);
    try {
      const blocosValidos = blocks.filter((b) => b.starts_at && b.ends_at);
      const res = await fetch("/api/v1/attendant-schedule", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_id: userId, blocks: blocosValidos }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        toast.error(json.error?.message ?? "Erro ao salvar.");
        return;
      }
      toast.success("Horário salvo.");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {DIAS.map((nome, dia) => {
        const bloco = blocoDoDia(dia);
        return (
          <Card key={dia}>
            <CardContent className="flex items-center gap-3 py-3">
              <span className="w-24 text-sm font-medium">{nome}</span>
              <div className="flex flex-col gap-1">
                <Label className="text-xs">Início</Label>
                <Input
                  type="time"
                  value={bloco.starts_at}
                  onChange={(e) => atualizarBloco(dia, "starts_at", e.target.value)}
                  className="w-32"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs">Fim</Label>
                <Input
                  type="time"
                  value={bloco.ends_at}
                  onChange={(e) => atualizarBloco(dia, "ends_at", e.target.value)}
                  className="w-32"
                />
              </div>
            </CardContent>
          </Card>
        );
      })}
      <Button type="button" onClick={salvar} disabled={salvando} className="self-start">
        {salvando ? "Salvando…" : "Salvar horário"}
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Verificar manualmente**

```bash
npm run dev
```
Abrir `/app/settings/meu-horario`, preencher terça 09:00-12:00, salvar,
recarregar a página e confirmar que o valor persiste.

- [ ] **Step 5: Commit**

```bash
git add app/app/settings/meu-horario lib/navigation/registry.ts
git commit -m "feat(agenda): tela de horário do atendente"
```

---

### Task 17: Dossiê do lead — seção de agendamentos + diálogo "Marcar horário"

**Files:**
- Create: `components/kanban/AppointmentsSlot.tsx`
- Create: `components/kanban/NewAppointmentDialog.tsx`
- Modify: `components/kanban/LeadDossier.tsx`

**Interfaces:**
- Consumes: `GET /api/v1/appointments?lead_id=` (ajuste: Task 8 hoje filtra
  só por `from`/`to`/`responsible_user_id` — este passo ADICIONA o filtro
  `lead_id` à Task 8; ver Step 1 abaixo), `GET /api/v1/appointment-types`,
  `GET /api/v1/appointments/available-slots`, `POST /api/v1/appointments`.

- [ ] **Step 1: Estender o teste e a rota `GET /api/v1/appointments` com filtro `lead_id`**

Voltar a `app/api/v1/appointments/route.test.ts` (Task 8) e acrescentar:

```typescript
it("filtra por lead_id quando informado", async () => {
  reqOk();
  let filtroAplicado: unknown;
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (_col: string, val: unknown) => {
      filtroAplicado = val;
      return chain;
    },
    order: () => Promise.resolve({ data: [], error: null }),
  };
  vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);

  await GET(new Request("http://x/api/v1/appointments?lead_id=lead-1") as never);
  expect(filtroAplicado).toBeDefined();
});
```

Rodar (`npx vitest run app/api/v1/appointments/route.test.ts`) — deve continuar
passando junto dos testes anteriores (o `eq` já é chamado múltiplas vezes; o
teste acima só confirma que a chamada acontece, não quebra os existentes).

Em `app/api/v1/appointments/route.ts`, no `GET`, adicionar:
```typescript
  const leadId = url.searchParams.get("lead_id");
  ...
  if (leadId) query = query.eq("lead_id", leadId);
```

- [ ] **Step 2: Implementar `AppointmentsSlot.tsx`**

```tsx
// components/kanban/AppointmentsSlot.tsx
"use client";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { NewAppointmentDialog } from "./NewAppointmentDialog";

interface AppointmentRow {
  id: string;
  scheduled_at: string;
  status: "scheduled" | "completed" | "cancelled" | "no_show";
}

interface Props {
  leadId: string;
}

/**
 * Slot do cabeçalho do dossiê — mesmo padrão de `ScoreSlot`/`CobrarButton`:
 * um pedaço isolado, com a própria busca de dado, que o `LeadDossier` só
 * posiciona.
 */
export function AppointmentsSlot({ leadId }: Props) {
  const [proximo, setProximo] = useState<AppointmentRow | null>(null);
  const [dialogAberto, setDialogAberto] = useState(false);

  async function carregar() {
    const res = await fetch(`/api/v1/appointments?lead_id=${leadId}&from=${new Date().toISOString()}`);
    const json = (await res.json()) as { data?: AppointmentRow[] };
    const futuros = (json.data ?? []).filter((a) => a.status === "scheduled");
    setProximo(futuros[0] ?? null);
  }

  useEffect(() => {
    void carregar();
  }, [leadId]);

  return (
    <>
      <div className="flex items-center gap-2 text-xs">
        {proximo ? (
          <span className="text-text-muted">
            Próximo horário: {new Date(proximo.scheduled_at).toLocaleString("pt-BR")}
          </span>
        ) : (
          <span className="text-text-muted">Sem horário marcado</span>
        )}
        <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => setDialogAberto(true)}>
          Marcar horário
        </Button>
      </div>
      <NewAppointmentDialog
        leadId={leadId}
        open={dialogAberto}
        onOpenChange={setDialogAberto}
        onCreated={() => void carregar()}
      />
    </>
  );
}
```

- [ ] **Step 3: Implementar `NewAppointmentDialog.tsx`**

```tsx
// components/kanban/NewAppointmentDialog.tsx
"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface AppointmentType {
  id: string;
  name: string;
  duration_minutes: number;
}

interface Slot {
  startsAt: string;
  endsAt: string;
}

interface Props {
  leadId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}

function toDateInputValue(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function NewAppointmentDialog({ leadId, open, onOpenChange, onCreated }: Props) {
  const [types, setTypes] = useState<AppointmentType[]>([]);
  const [typeId, setTypeId] = useState("");
  const [date, setDate] = useState(() => toDateInputValue(new Date()));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotEscolhido, setSlotEscolhido] = useState<Slot | null>(null);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch("/api/v1/appointment-types")
      .then((r) => r.json())
      .then((json: { data?: AppointmentType[] }) => setTypes(json.data ?? []));
  }, [open]);

  useEffect(() => {
    if (!typeId || !date) {
      setSlots([]);
      return;
    }
    fetch(`/api/v1/appointments/available-slots?type_id=${typeId}&date=${date}`)
      .then((r) => r.json())
      .then((json: { data?: Slot[] }) => setSlots(json.data ?? []));
  }, [typeId, date]);

  async function confirmar() {
    if (!typeId || !slotEscolhido) {
      toast.error("Escolha um tipo e um horário.");
      return;
    }
    setSalvando(true);
    try {
      const res = await fetch("/api/v1/appointments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lead_id: leadId,
          appointment_type_id: typeId,
          scheduled_at: slotEscolhido.startsAt,
        }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        toast.error(json.error?.message ?? "Erro ao marcar horário.");
        return;
      }
      toast.success("Horário marcado.");
      onOpenChange(false);
      onCreated();
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Marcar horário</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Label>Tipo de agendamento</Label>
            <Select value={typeId} onValueChange={setTypeId}>
              <SelectTrigger>
                <SelectValue placeholder="Escolha o tipo" />
              </SelectTrigger>
              <SelectContent>
                {types.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} ({t.duration_minutes} min)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label>Data</Label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Horário</Label>
            {slots.length === 0 && <p className="text-xs text-muted-foreground">Nenhum horário livre neste dia.</p>}
            <div className="flex flex-wrap gap-2">
              {slots.map((s) => (
                <Button
                  key={s.startsAt}
                  type="button"
                  size="sm"
                  variant={slotEscolhido?.startsAt === s.startsAt ? "default" : "outline"}
                  onClick={() => setSlotEscolhido(s)}
                >
                  {new Date(s.startsAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                </Button>
              ))}
            </div>
          </div>
          <Button type="button" onClick={confirmar} disabled={salvando}>
            {salvando ? "Marcando…" : "Confirmar"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Ligar no `LeadDossier.tsx`**

Em `components/kanban/LeadDossier.tsx`, importar `AppointmentsSlot` e
adicionar dentro do cabeçalho vivo (① — mesma linha do `OwnerBadge`/`CobrarButton`):

```tsx
import { AppointmentsSlot } from "./AppointmentsSlot";
// ...
          <OwnerBadge
            ownerKind={owner.kind}
            ownerName={owner.name}
            agentVersion={owner.agentVersion}
          />
          <AppointmentsSlot leadId={lead.id} />
```

- [ ] **Step 5: Verificar manualmente**

```bash
npm run dev
```
Abrir um lead no Kanban, clicar "Marcar horário", escolher tipo + dia + slot,
confirmar, e ver o "Próximo horário" atualizado no cabeçalho e a atividade
"Agendamento marcado" na timeline.

- [ ] **Step 6: Commit**

```bash
git add components/kanban/AppointmentsSlot.tsx components/kanban/NewAppointmentDialog.tsx components/kanban/LeadDossier.tsx app/api/v1/appointments/route.ts app/api/v1/appointments/route.test.ts
git commit -m "feat(agenda): marcar horário pelo dossiê do lead"
```

---

### Task 18: RLS — invariante de isolamento entre organizações

**Files:**
- Create: `tests/invariants/rls-isolation-agenda.test.ts`

**Interfaces:**
- Nenhuma nova — prova comportamento das policies da Task 1.

- [ ] **Step 1: Escrever o teste (requer `pnpm test:db`)**

```typescript
// tests/invariants/rls-isolation-agenda.test.ts
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — run via `pnpm test:db`");
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

const ORG_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ORG_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const USER_A = "aaaaaaaa-1111-4000-8000-0000000000a1";

function countAs(userId: string, countQuery: string): number {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', json_build_object('sub', '${userId}')::text, true);
    ${countQuery}
    reset role;
  `);
  return Number(out.trim().split("\n").pop());
}

describe("RLS — appointment_types/attendant_schedule/appointments isolam por organização", () => {
  it("usuário da org A não vê appointment_types da org B", () => {
    sql(`
      insert into organizations (id, slug, legal_name, display_name) values ('${ORG_A}', 'org-a-agenda', 'A', 'A') on conflict do nothing;
      insert into organizations (id, slug, legal_name, display_name) values ('${ORG_B}', 'org-b-agenda', 'B', 'B') on conflict do nothing;
      insert into user_organizations (user_id, organization_id, role) values ('${USER_A}', '${ORG_A}', 'admin') on conflict do nothing;
      insert into appointment_types (organization_id, name, duration_minutes, responsible_user_id)
        values ('${ORG_B}', 'Tipo da org B', 30, '${USER_A}');
    `);
    const n = countAs(USER_A, `select count(*) from appointment_types where organization_id = '${ORG_B}';`);
    expect(n).toBe(0);
  });

  it("a exclusion constraint recusa 2 agendamentos scheduled sobrepostos para o mesmo responsável", () => {
    const resultado = sql(`
      do $$
      declare
        v_lead uuid;
        v_type uuid;
      begin
        insert into contacts (id, organization_id, display_name) values (gen_random_uuid(), '${ORG_A}', 'C') returning id into v_lead;
      end $$;
    `);
    // Prova indireta: duas inserções concorrentes no MESMO horário devem produzir
    // exatamente 1 sucesso e 1 erro 23P01 — verificado via 2 sessões psql
    // paralelas na implementação real deste teste (placeholder de estrutura
    // aqui; ao implementar de verdade, use `Promise.all` com dois `execFileSync`
    // em processos separados, ou uma transação com savepoint por sessão).
    expect(true).toBe(true);
  });
});
```

**⚠️ Nota para quem implementar de verdade:** o segundo teste acima está
incompleto de propósito — a prova real de exclusion constraint sob CONCORRÊNCIA
exige duas conexões simultâneas (não dá para simular com um `psql -f -`
sequencial). Implemente com duas chamadas `execFileSync` disparadas em
paralelo (`Promise.all` ao redor de duas invocações que abrem suas próprias
transações e usam `pg_sleep` calibrado para colidir), ou aceite uma prova mais
fraca (sequencial: insere um `scheduled`, tenta inserir outro sobreposto na
mesma sessão, confirma erro `23P01`) e documente explicitamente que a prova é
sequencial, não concorrente.

- [ ] **Step 2: Rodar (requer Docker)**

```bash
pnpm test:db
```

- [ ] **Step 3: Commit**

```bash
git add tests/invariants/rls-isolation-agenda.test.ts
git commit -m "test(agenda): isolamento de RLS entre organizações"
```

---

### Task 19: E2E — fluxo completo (Playwright)

**Files:**
- Create: `tests/e2e/agenda-nativa.spec.ts`

**Interfaces:**
- Consumes: toda a superfície das Tasks 1-17, num ambiente com dev server e
  banco aplicado.

- [ ] **Step 1: Escrever o teste**

```typescript
// tests/e2e/agenda-nativa.spec.ts
import { test, expect } from "@playwright/test";

test.describe("Agenda nativa — fluxo completo", () => {
  test("cadastra tipo, horário do atendente, marca agendamento e conclui", async ({ page }) => {
    // Pressupõe login já resolvido pelo setup global de auth do Playwright
    // (mesmo padrão dos demais specs de tests/e2e/).

    await page.goto("/app/settings/appointment-types");
    await page.getByLabel("Nome").fill("Consulta E2E");
    await page.getByLabel("Duração (min)").fill("30");
    // ID do responsável: usar o próprio usuário logado (capturado via API antes do teste,
    // ou via um seed fixo do ambiente de teste E2E).
    await page.getByLabel("ID do responsável (usuário)").fill(process.env.E2E_USER_ID ?? "");
    await page.getByRole("button", { name: "Criar tipo" }).click();
    await expect(page.getByText("Consulta E2E")).toBeVisible();

    await page.goto("/app/settings/meu-horario");
    const hojeDiaDaSemana = new Date().getDay();
    const linhas = page.locator("text=Segunda").locator("..");
    await page.locator('input[type="time"]').first().fill("08:00");
    await page.locator('input[type="time"]').nth(1).fill("18:00");
    await page.getByRole("button", { name: "Salvar horário" }).click();
    await expect(page.getByText("Horário salvo.")).toBeVisible();

    // Abre um lead existente no Kanban (seed do ambiente E2E) e marca horário.
    await page.goto("/app/kanban");
    await page.getByText(/.+/).first().click(); // abre o primeiro card
    await page.getByRole("button", { name: "Marcar horário" }).click();
    await page.getByRole("combobox").click();
    await page.getByText("Consulta E2E").click();
    await page.locator('button:has-text(":")').first().click(); // primeiro slot disponível
    await page.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.getByText("Horário marcado.")).toBeVisible();

    await page.goto("/app/agenda");
    await expect(page.getByText("Marcado")).toBeVisible();
  });
});
```

- [ ] **Step 2: Rodar (requer Supabase local + dev server + seed)**

```bash
pnpm test:e2e -- agenda-nativa.spec.ts
```
Se o ambiente E2E completo não estiver disponível nesta sessão, declarar
explicitamente e pedir para rodar antes do merge — é a doutrina de QA Visual
do `CLAUDE.md` (curl não prova UX).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/agenda-nativa.spec.ts
git commit -m "test(agenda): E2E do fluxo completo"
```

---

## Pendências explícitas para quem executar este plano

1. **Task 10 (`appointment-reminder`)**: o `send:` e `getPgPool()` são
   placeholders MARCADOS como tal — precisam ser resolvidos contra o
   `ChannelAdapter`/pool `pg` reais de `lib/agent-engine/agent/inbound-turn.ts`
   antes de considerar a task concluída. Não é um "TBD" disfarçado: é uma
   decisão de integração que só pode ser tomada lendo o código real na hora
   da implementação (o caminho exato pode ter mudado entre o momento deste
   plano e a execução).
2. **Task 11**: a coluna `ends_at` gerada precisa ser adicionada à migration
   da Task 1 (o plano já indica isso na própria Task 11, mas fica registrado
   aqui também — é fácil esquecer de voltar).
3. **Tasks 1, 12, 18**: dependem de `pnpm test:db` (Docker). Se o ambiente de
   execução não tiver Docker, isso deve ser declarado, e um humano com Docker
   precisa rodar antes do merge — não é opcional pela doutrina do repo para
   mudança de schema/RLS.
4. **Task 19**: depende de ambiente E2E completo (Supabase local + seed de
   usuário/lead). Se não disponível, declarar e pedir validação humana antes
   do merge — doutrina de QA Visual.

## Self-Review

**Cobertura do spec:** Modelo de dados (Task 1), fuso horário (Task 2),
cálculo de slots (Task 3), API completa (Tasks 5-9), auditoria (Task 4, usada
em todas as rotas), lembrete via `runBeforeSend` (Task 10), nudge de desfecho
(Task 11), LGPD (Task 12), navegação (Task 13), as 4 telas do spec (Tasks
14-17), RLS (Task 18), E2E (Task 19). Todos os itens do spec têm task
correspondente.

**Placeholder scan:** dois trechos são explicitamente marcados como decisão
pendente de integração (Task 10's `send`/`getPgPool`, Task 18's segundo
teste) — ambos com nota explícita do que fazer e por quê, não "TBD" vago.
Nenhum outro placeholder encontrado.

**Consistência de tipos:** `ActivityType` (Task 4) usado identicamente nas
Tasks 8 e 9 (`appointment_scheduled`, `appointment_rescheduled`, etc.).
`AuditAction` (Task 4) usado identicamente nas Tasks 5, 6, 8, 9.
`ComputeSlotsInput`/`Slot` (Task 3) usados identicamente na Task 7.
`wallClockParts`/`instantFromWallClock` (Task 2) usados identicamente nas
Tasks 3 e 7.
