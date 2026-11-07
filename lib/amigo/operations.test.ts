import { describe, expect, it } from "vitest";
import {
  runDurableOperation,
  operationTarget,
  type OperationJournal,
  type OperationRecord,
} from "./operations";

function journal(): OperationJournal {
  const rows = new Map<string, OperationRecord>();
  return {
    async reserve(command) {
      const previous = rows.get(command.key);
      if (previous) return { created: false, record: previous };
      const competing = [...rows.values()].some(
        (r) =>
          r.targetId === command.targetId && ["prepared", "sent", "uncertain"].includes(r.state),
      );
      if (competing) throw new Error("operação em andamento");
      const record: OperationRecord = {
        ...command,
        id: command.key,
        state: "prepared",
        result: null,
      };
      rows.set(command.key, record);
      return { created: true, record };
    },
    async update(id, state, result) {
      const row = rows.get(id);
      if (!row) throw new Error("missing");
      rows.set(id, { ...row, state, result: result ?? null });
    },
  };
}
const command = {
  key: "operacao-1",
  operation: "attendance_create",
  requestHash: "hash-1",
  targetId: "paciente-horario",
};
describe("recibos duráveis Amigo", () => {
  it("alterações concorrentes de um paciente compartilham o mesmo alvo", () => {
    expect(operationTarget("patient_update", { patientId: 7, name: "A" })).toBe(
      operationTarget("patient_update", { patientId: 7, name: "B" }),
    );
  });
  it("replay retorna o recibo sem executar novamente", async () => {
    const db = journal();
    let effects = 0;
    const execute = async () => {
      effects++;
      return { data: { id: 90 }, status: "success" };
    };
    await runDurableOperation(db, command, execute);
    expect(await runDurableOperation(db, command, execute)).toMatchObject({
      state: "confirmed",
      result: { data: { id: 90 } },
    });
    expect(effects).toBe(1);
  });
  it("timeout continua incerto no replay e não repete o efeito externo", async () => {
    const db = journal();
    let effects = 0;
    const execute = async () => {
      effects++;
      throw new Error("conexão interrompida");
    };
    const first = await runDurableOperation(db, command, execute);
    expect(first.state).toBe("uncertain");
    expect((await runDurableOperation(db, command, execute)).state).toBe("uncertain");
    expect(effects).toBe(1);
  });
  it("mesma chave com payload diferente não executa", async () => {
    const db = journal();
    let effects = 0;
    await runDurableOperation(db, command, async () => {
      effects++;
      return { data: true };
    });
    await expect(
      runDurableOperation(db, { ...command, requestHash: "diferente" }, async () => {
        effects++;
        return {};
      }),
    ).rejects.toThrow();
    expect(effects).toBe(1);
  });
  it("serializa duas chaves para a mesma consulta enquanto a primeira aguarda retorno", async () => {
    const db = journal();
    let release!: () => void;
    let effects = 0;
    const waiting = new Promise<void>((r) => {
      release = r;
    });
    const first = runDurableOperation(db, command, async () => {
      effects++;
      await waiting;
      return { data: true };
    });
    await Promise.resolve();
    await expect(
      runDurableOperation(db, { ...command, key: "operacao-2" }, async () => {
        effects++;
        return {};
      }),
    ).rejects.toThrow();
    release();
    await first;
    expect(effects).toBe(1);
  });
  it("criação do mesmo paciente e horário tem o mesmo alvo mesmo com chave diferente", () => {
    expect(
      operationTarget("attendance_create", {
        patient_id: 7,
        event_id: 2,
        user_id: 3,
        place_id: 1,
        start_date: "2026-11-07 14:00",
      }),
    ).toBe(
      operationTarget("attendance_create", {
        start_date: "2026-11-07 14:00",
        place_id: 1,
        user_id: 3,
        event_id: 2,
        patient_id: 7,
      }),
    );
  });
});
