// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestAmigo, AmigoError } from "./transport";
import type { AmigoOperation } from "./contracts";

const token = "token-super-secreto-de-teste";
// Expectativas literais derivadas da OpenAPI 1.2.0; não importar a tabela de rotas da implementação.
const cases: [AmigoOperation, unknown, string, string, unknown, unknown][] = [
  [
    "patient_search",
    { cpf: "00000000000", contact_cellphone: "81999999999" },
    "GET",
    "/patients/exists?cpf=00000000000&contact_cellphone=81999999999",
    undefined,
    { id: 1, name: "Teste" },
  ],
  ["patient_get", { patientId: 1 }, "GET", "/patients/1", undefined, { id: 1 }],
  [
    "patient_create",
    { name: "Teste", insurance_id: 2, address_city: "Recife" },
    "POST",
    "/patients",
    { name: "Teste", insurance_id: 2, address_city: "Recife" },
    { id: 1 },
  ],
  [
    "patient_update",
    { patientId: 1, name: "Teste", cpf_responsible: "00000000000" },
    "PUT",
    "/patients/1",
    { name: "Teste", cpf_responsible: "00000000000" },
    { id: 1 },
  ],
  [
    "patient_doctors",
    { patientId: 1 },
    "GET",
    "/patients/1/doctors",
    undefined,
    [
      {
        id: 2,
        specialty: null,
        patient_insurance_id: null,
        last_attendance: { insurance_id: 3, place_id: 4, event_id: 5 },
      },
    ],
  ],
  [
    "patient_birthdays",
    { date: "11-06" },
    "GET",
    "/patients/birthday?date=11-06",
    undefined,
    [{ id: 1, age: null, health_insurance: null }],
  ],
  [
    "insurances",
    { user_id: 2, place_id: 3 },
    "GET",
    "/insurances?user_id=2&place_id=3",
    undefined,
    [{ id: 1, name: "Convênio" }],
  ],
  [
    "insurance_plans",
    { insurance_group_id: 1, event_id: 2, user_id: 3, place_id: 4, only_schedulable: false },
    "GET",
    "/insurances/plans/1?event_id=2&user_id=3&place_id=4&only_schedulable=false",
    undefined,
    [],
  ],
  [
    "insurance_products",
    { insurance_id: 1 },
    "GET",
    "/insurances/1/products",
    undefined,
    [{ id: 2, name: "Ouro" }],
  ],
  [
    "doctors",
    { to_confirm: false },
    "GET",
    "/doctors?to_confirm=false",
    undefined,
    [{ id: 1, name: "Teste", specialty: "Cardiologia" }],
  ],
  [
    "doctors_available",
    {
      insurance_id: 1,
      insurance_product_id: 2,
      event_id: 3,
      place_id: 4,
      specialty: ["Cardiologia", "Clínica geral"],
      only_schedulable: true,
    },
    "GET",
    "/doctors/available?insurance_id=1&insurance_product_id=2&event_id=3&place_id=4&specialty=Cardiologia&specialty=Cl%C3%ADnica+geral&only_schedulable=true",
    undefined,
    [{ id: 1, title: null, gender: null }],
  ],
  [
    "specialties",
    { insurance_id: 1, place_id: 2 },
    "GET",
    "/doctors/specialties?insurance_id=1&place_id=2",
    undefined,
    ["Cardiologia"],
  ],
  [
    "doctor_dates",
    {
      id: 1,
      insurance_id: 2,
      insurance_product_id: 3,
      event_id: 4,
      place_id: 5,
      patient_id: 6,
      gender: "Feminino",
      born: "2000-02-29",
      allow_same_day: false,
      months_ahead: 6,
    },
    "GET",
    "/doctors/1/available-dates?insurance_id=2&insurance_product_id=3&event_id=4&place_id=5&patient_id=6&gender=Feminino&born=2000-02-29&allow_same_day=false&months_ahead=6",
    undefined,
    ["20/08/2024"],
  ],
  [
    "attendance_create",
    {
      insurance_id: 1,
      insurance_product_id: 2,
      event_id: 3,
      user_id: 4,
      place_id: 5,
      patient_id: 6,
      start_date: "2026-11-06 08:30",
      allow_same_day: false,
    },
    "POST",
    "/attendances",
    {
      insurance_id: 1,
      insurance_product_id: 2,
      event_id: 3,
      user_id: 4,
      place_id: 5,
      patient_id: 6,
      start_date: "2026-11-06 08:30",
      allow_same_day: false,
    },
    { id: 7, is_arrival_order: false },
  ],
  [
    "attendances",
    { place_id: 1, start_date: "2026-11-01", end_date: "2026-11-30", status: "ALL" },
    "GET",
    "/attendances?place_id=1&start_date=2026-11-01&end_date=2026-11-30&status=ALL",
    undefined,
    [
      {
        id: 1,
        status: "scheduled",
        shift: "MORNING",
        arrival_start_time: "08:00",
        arrival_end_time: "12:00",
        timegrids: [{ start: "08:00", end: "12:00" }],
      },
    ],
  ],
  [
    "patient_attendances",
    { patient_id: 1, place_id: 2, start_date: "2026-11-01", end_date: "2026-11-30" },
    "GET",
    "/attendances/1?place_id=2&start_date=2026-11-01&end_date=2026-11-30",
    undefined,
    [],
  ],
  ["attendance_cancel", { id: 1 }, "PUT", "/attendances/cancel/1", undefined, true],
  [
    "attendance_status",
    { status: "arrived", patient_id: 1, attendance_id: 2 },
    "PUT",
    "/attendances/arrived",
    { patient_id: 1, attendance_id: 2 },
    true,
  ],
  [
    "attendance_reschedule",
    { id: 1, date: "2026-11-07 19:30" },
    "PUT",
    "/attendances/1/reschedule",
    { date: "2026-11-07 19:30" },
    true,
  ],
  [
    "places",
    { user_id: 1, event_id: 2, only_schedulable: false },
    "GET",
    "/places?user_id=1&event_id=2&only_schedulable=false",
    undefined,
    [{ id: 1, prefix: null, address: "" }],
  ],
  [
    "events",
    { insurance_id: 1, place_id: 2, user_id: 3, only_schedulable: true },
    "GET",
    "/events?insurance_id=1&place_id=2&user_id=3&only_schedulable=true",
    undefined,
    [{ id: 1, insurances: "[1,2]", procedures: "[]", matmeds: "[]", preview_name: null }],
  ],
  [
    "calendar",
    { event_id: 1, place_id: 2, patient_id: 3, insurance_id: 4, insurance_product_id: 5 },
    "GET",
    "/calendar?event_id=1&place_id=2&patient_id=3&insurance_id=4&insurance_product_id=5",
    undefined,
    [
      {
        date: "2024-09-26",
        status: "AVAILABLE",
        slotsByUser: [
          {
            user: { id: 236, name: "Teste" },
            event: { name: "Consulta" },
            slots: [
              {
                start: "19:00",
                end: "19:30",
                timegrid_id: 2422,
                user_id: 236,
                event_id: 26,
                place_id: 88,
                id: "88-26-236-2024-09-26-1727290800",
              },
            ],
            slots_total: 20,
          },
        ],
      },
    ],
  ],
];
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const call = (
  fetchImpl: typeof fetch,
  operation: AmigoOperation = "places",
  input: unknown = {},
  timeoutMs?: number,
) => requestAmigo(token, operation, input, { fetchImpl, timeoutMs });
afterEach(() => vi.useRealTimers());

describe("transporte Amigo", () => {
  it.each(cases)(
    "%s envia método/path/query/body e valida resposta documentada",
    async (op, input, method, path, body, data) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ status: "success", data }));
      const result = await call(fetchImpl, op, input);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(String(url)).toBe(`https://amigobot-api.amigoapp.com.br${path}`);
      expect(init).toMatchObject({
        method,
        cache: "no-store",
        redirect: "error",
        headers: expect.objectContaining({
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        }),
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.body === undefined ? undefined : JSON.parse(String(init.body))).toEqual(body);
      if (body) expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(result).toEqual({ status: "success", data: op === "patient_search" ? [data] : data });
    },
  );
  it.each(cases)(
    "%s rejeita resposta sem identificação mínima",
    async (op, input, _method, _path, _body, data) => {
      const invalid = typeof data === "boolean" ? "true" : Array.isArray(data) ? [{}] : {};
      await expect(
        call(
          vi.fn<typeof fetch>().mockResolvedValue(json({ status: "success", data: invalid })),
          op,
          input,
        ),
      ).rejects.toMatchObject({ code: "AMIGO_INVALID_RESPONSE", status: 502 });
    },
  );
  it("preserva múltiplos pacientes, campos extras e dados mascarados sem escolher um", async () => {
    const data = [
      { id: 1, cpf: "***.456.789-**", extra: "valor" },
      { id: 2, email: null },
    ];
    await expect(
      call(
        vi.fn<typeof fetch>().mockResolvedValue(json({ status: "success", data })),
        "patient_search",
        { contact_cellphone: "81999999999" },
      ),
    ).resolves.toEqual({ status: "success", data });
  });
  it("preserva slot por turno e data civil sem conversão de fuso", async () => {
    const data = [
      {
        id: "slot-1",
        user_id: 1,
        start_date: "2024-08-20T11:00:00.000Z",
        end_date: "2024-08-20T11:30:00.000Z",
        hour: "08:00",
        interval: 30,
        day_of_week: 2,
        timegrid_id: 4579,
        place_id: null,
        formatted_start_date: "2024-08-20 08:00",
        is_arrival_order: true,
        shift: "MORNING",
      },
    ];
    await expect(
      call(
        vi.fn<typeof fetch>().mockResolvedValue(json({ status: "success", data })),
        "doctor_dates",
        { id: 1, event_id: 2, date: "2024-08-20" },
      ),
    ).resolves.toEqual({ status: "success", data });
  });
  it.each(["attendance_cancel", "attendance_status", "attendance_reschedule"] as const)(
    "%s exige data===true; false é recusa explícita",
    async (op) => {
      const input = cases.find((c) => c[0] === op)![1];
      await expect(
        call(
          vi.fn<typeof fetch>().mockResolvedValue(json({ status: "success", data: false })),
          op,
          input,
        ),
      ).rejects.toMatchObject({ code: "AMIGO_REJECTED", uncertain: false });
    },
  );
  it.each([400, 401, 403, 404, 408, 429, 500, 503])(
    "HTTP %s é erro seguro e sem reenvio",
    async (status) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          json({ status: "error", code: token, message: `segredo ${token}` }, status),
        );
      const error = await call(fetchImpl, "attendance_cancel", { id: 1 }).catch((e) => e);
      expect(error).toBeInstanceOf(AmigoError);
      expect(error).toMatchObject({ status, uncertain: status >= 500 || status === 408 });
      expect(`${error.stack}${JSON.stringify(error)}`).not.toContain(token);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it("expõe Retry-After seguro sem repetir a solicitação", async () => {
    const response = json({ status: "error" }, 429);
    response.headers.set("Retry-After", "30");
    await expect(call(vi.fn<typeof fetch>().mockResolvedValue(response))).rejects.toMatchObject({
      code: "AMIGO_RATE_LIMITED",
      retryAfterSeconds: 30,
    });
  });
  it.each([
    {},
    { data: [] },
    { data: [], status: "error", message: token },
    { data: null, status: "success" },
  ])("recusa envelope inválido sem refletir mensagens %j", async (envelope) => {
    await expect(
      call(vi.fn<typeof fetch>().mockResolvedValue(json(envelope))),
    ).rejects.toBeInstanceOf(AmigoError);
  });
  it("recusa operação e input inválidos antes de fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(call(fetchImpl, "places", { url: "https://evil.invalid" })).rejects.toMatchObject({
      code: "AMIGO_INVALID_INPUT",
      uncertain: false,
    });
    await expect(call(fetchImpl, "toString" as AmigoOperation)).rejects.toMatchObject({
      code: "AMIGO_INVALID_INPUT",
    });
    await expect(requestAmigo("", "places", {}, { fetchImpl })).rejects.toMatchObject({
      code: "AMIGO_NOT_CONFIGURED",
    });
    await expect(requestAmigo("bad\r\nheader", "places", {}, { fetchImpl })).rejects.toBeInstanceOf(
      AmigoError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["places", "attendance_cancel"] as const)(
    "%s sanitiza falha de rede e só mutação fica incerta",
    async (op) => {
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error(`Bearer ${token}`));
      const error = await call(fetchImpl, op, op === "places" ? {} : { id: 1 }).catch((e) => e);
      expect(error).toMatchObject({ code: "AMIGO_UNAVAILABLE", uncertain: op !== "places" });
      expect(`${error.stack}${JSON.stringify(error)}`).not.toContain(token);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it("timeout limita fetch mesmo se implementação injetada ignorar abort; não reenvia mutação", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const result = expect(
      call(fetchImpl, "attendance_cancel", { id: 1 }, 20),
    ).rejects.toMatchObject({ code: "AMIGO_TIMEOUT", status: 504, uncertain: true });
    await vi.advanceTimersByTimeAsync(21);
    await result;
    expect(fetchImpl.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("timeout inclui leitura do corpo e cancela stream", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = expect(
      call(fetchImpl, "attendance_cancel", { id: 1 }, 20),
    ).rejects.toMatchObject({ code: "AMIGO_TIMEOUT", uncertain: true });
    await vi.advanceTimersByTimeAsync(21);
    await result;
    expect(cancel).toHaveBeenCalled();
  });
  it.each([false, true])(
    "limita resposta em bytes, inclusive sem Content-Length (%s)",
    async (declared) => {
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
          },
          cancel,
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...(declared ? { "Content-Length": String(2 * 1024 * 1024 + 1) } : {}),
          },
        },
      );
      await expect(
        call(vi.fn<typeof fetch>().mockResolvedValue(response), "attendance_cancel", { id: 1 }),
      ).rejects.toMatchObject({ code: "AMIGO_RESPONSE_TOO_LARGE", uncertain: true });
      expect(cancel).toHaveBeenCalled();
    },
  );
  it.each([
    new Response("nao json"),
    new Response("{}", { status: 302, headers: { Location: "https://evil.invalid" } }),
    new Response("{}", { headers: { "Content-Type": "text/html" } }),
  ])("recusa JSON/redirect/content type inválido", async (response) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(call(fetchImpl, "attendance_cancel", { id: 1 })).rejects.toBeInstanceOf(
      AmigoError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("recusa insurances JSON inválido e estrutura interna inválida do calendário", async () => {
    await expect(
      call(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            json({ status: "success", data: [{ id: 1, insurances: "nonsense" }] }),
          ),
        "events",
      ),
    ).rejects.toMatchObject({ code: "AMIGO_INVALID_RESPONSE" });
    await expect(
      call(
        vi.fn<typeof fetch>().mockResolvedValue(
          json({
            status: "success",
            data: [{ date: "2026-11-06", slotsByUser: [{ user: {}, slots: [{}] }] }],
          }),
        ),
        "calendar",
        { event_id: 1, place_id: 2 },
      ),
    ).rejects.toMatchObject({ code: "AMIGO_INVALID_RESPONSE" });
  });
});
