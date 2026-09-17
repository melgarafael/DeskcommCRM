"""Instrumento sintético: Wasm sem WASI; autoridade pertence ao broker do host."""

import importlib.metadata
import json
import os
from pathlib import Path
import platform
import resource
import statistics
import sys
import time
from dataclasses import dataclass

import wasmtime

FIXTURES = Path(__file__).parent / "fixtures"
FUEL = 100_000
MEMORY_BYTES = 2 * 65_536
OUTPUT_BYTES = 1_024


@dataclass(frozen=True)
class Authority:
    organization: str
    actor: str
    grants: frozenset


AUTHORITY = Authority("synthetic-org-a", "synthetic-actor-a", frozenset({"read_record"}))
RECORDS = {1: ("synthetic-org-a", 41), 2: ("synthetic-org-b", 99)}


def elapsed(start):
    return (time.perf_counter_ns() - start) / 1_000_000


class Sandbox:
    def __init__(self):
        start = time.perf_counter_ns()
        config = wasmtime.Config()
        config.consume_fuel = True
        config.wasm_threads = False
        self.engine = wasmtime.Engine(config)
        self.modules = {}
        self.engine_ms = elapsed(start)

    def instantiate(self, fixture, authority=AUTHORITY):
        if fixture not in self.modules:
            self.modules[fixture] = wasmtime.Module.from_file(self.engine, str(FIXTURES / f"{fixture}.wat"))
        store = wasmtime.Store(self.engine)
        store.set_fuel(FUEL)
        store.set_limits(memory_size=MEMORY_BYTES, table_elements=100, instances=1, tables=1, memories=1)
        linker = wasmtime.Linker(self.engine)
        output = bytearray()
        audit = []

        def read_record(record_id):
            # O módulo fornece somente o ID; identidade e concessão vêm do host.
            record = RECORDS.get(record_id)
            allowed = "read_record" in authority.grants and record is not None and record[0] == authority.organization
            audit.append({"organization": authority.organization, "actor": authority.actor, "allowed": allowed})
            if not allowed:
                raise wasmtime.Trap("capability_denied")
            return record[1]

        def emit(caller, pointer, size):
            # Limite acumulado antes de copiar bytes do guest para o host.
            if size < 0 or len(output) + size > OUTPUT_BYTES:
                raise wasmtime.Trap("output_limit")
            memory = caller.get("memory")
            if not isinstance(memory, wasmtime.Memory) or pointer < 0 or pointer + size > memory.data_len(caller):
                raise wasmtime.Trap("output_bounds")
            output.extend(memory.read(caller, pointer, pointer + size))

        def hang():
            print(json.dumps({"event": "host_entered", "pid": os.getpid()}), flush=True)
            while True:
                time.sleep(60)

        linker.define_func("broker", "read_record", wasmtime.FuncType([wasmtime.ValType.i32()], [wasmtime.ValType.i32()]), read_record)
        linker.define_func("broker", "emit", wasmtime.FuncType([wasmtime.ValType.i32(), wasmtime.ValType.i32()], []), emit, access_caller=True)
        # Concessão exclusivamente do cenário de supervisão, nunca do guest.
        if fixture == "host-hang":
            linker.define_func("broker", "hang", wasmtime.FuncType([], []), hang)
        instance = linker.instantiate(store, self.modules[fixture])
        return store, instance.exports(store), output, audit

    def valid(self):
        store, exports, _, _ = self.instantiate("capability")
        return exports["run"](store, 1)


def main(mode):
    started = time.perf_counter_ns()
    sandbox = Sandbox()
    if mode == "host-hang":
        store, exports, _, _ = sandbox.instantiate("host-hang")
        exports["run"](store)
        raise RuntimeError("host unexpectedly returned")
    if mode == "valid":
        value = sandbox.valid()
        return {"value": value, "engine_ms": sandbox.engine_ms, "engine_compile_instantiate_call_ms": elapsed(started), "rss_peak_bytes": peak_rss()}
    checks = []

    def check(identifier, name, operation):
        start = time.perf_counter_ns()
        try:
            observed = operation()
            # Toda prova adversarial tem uma nova instância válida como controle.
            if sandbox.valid() != 41:
                raise AssertionError("recovery returned wrong value")
            checks.append({"id": identifier, "name": name, "passed": True, "observed": observed, "recovery_value": 41, "duration_ms": elapsed(start)})
        except Exception as error:
            checks.append({"id": identifier, "name": name, "passed": False, "observed": f"{type(error).__name__}: {error}", "duration_ms": elapsed(start)})

    def valid():
        store, exports, _, audit = sandbox.instantiate("capability")
        assert exports["run"](store, 1) == 41
        assert audit == [{"organization": AUTHORITY.organization, "actor": AUTHORITY.actor, "allowed": True}]
        return "read_record(1)=41; autoridade e ator do host confirmados na auditoria sintética"

    def expect_trap(fixture, arguments, expected, authority=AUTHORITY, export="run"):
        try:
            store, exports, _, _ = sandbox.instantiate(fixture, authority)
            exports[export](store, *arguments)
        except (wasmtime.Trap, wasmtime.WasmtimeError) as error:
            assert expected in str(error), str(error)
            return str(error)
        raise AssertionError("expected rejection did not occur")

    check("valid", "Executar capacidade autorizada", valid)
    check("cross_org", "Recusar registro de outra organização", lambda: expect_trap("capability", [2], "capability_denied"))
    check("missing_grant", "Recusar leitura sem concessão", lambda: expect_trap("capability", [1], "capability_denied", Authority(AUTHORITY.organization, AUTHORITY.actor, frozenset())))
    check("filesystem", "Recusar import de filesystem", lambda: expect_trap("filesystem", [], "unknown import"))
    check("network", "Recusar import de rede", lambda: expect_trap("network", [], "unknown import"))
    check("fuel", "Interromper execução sem fim", lambda: expect_trap("infinite", [], "fuel"))
    check("memory_initial", "Recusar memória inicial acima da cota", lambda: expect_trap("memory-initial", [], "memory minimum size"))

    def memory_grow():
        store, exports, _, _ = sandbox.instantiate("memory-grow")
        assert exports["run"](store) == -1
        assert exports["memory"].data_len(store) == 65_536
        return "memory.grow(2)=-1; memória preservada em 65536 bytes"

    check("memory", "Recusar crescimento acima da cota", memory_grow)
    check("output", "Recusar saída acima da cota antes da cópia", lambda: expect_trap("output", [OUTPUT_BYTES + 1], "output_limit"))
    check("output_cumulative", "Aplicar cota acumulada por execução", lambda: expect_trap("output", [], "output_limit", export="cumulative"))

    def output_at_limit():
        store, exports, output, _ = sandbox.instantiate("output")
        exports["run"](store, OUTPUT_BYTES)
        assert len(output) == OUTPUT_BYTES
        return "1024 bytes aceitos; limite inclusivo"

    check("output_at_limit", "Aceitar saída no limite", output_at_limit)
    store, exports, _, _ = sandbox.instantiate("capability")
    warm = []
    for _ in range(50):
        store.set_fuel(FUEL)
        start = time.perf_counter_ns()
        assert exports["run"](store, 1) == 41
        warm.append(elapsed(start))
    return {
        "checks": checks,
        "environment": {"python": platform.python_version(), "wasmtime": importlib.metadata.version("wasmtime"), "machine": platform.machine()},
        "measurements": {"engine_ms": sandbox.engine_ms, "suite_ms": elapsed(started), "warm_call_ms": summary(warm), "rss_peak_bytes": peak_rss(), "cpu_seconds": resource.getrusage(resource.RUSAGE_SELF).ru_utime + resource.getrusage(resource.RUSAGE_SELF).ru_stime},
        "limits": {"fuel_per_call": FUEL, "linear_memory_bytes": MEMORY_BYTES, "output_bytes_per_call": OUTPUT_BYTES, "tables": 1, "table_elements": 100, "instances": 1, "memories": 1},
    }


def summary(samples):
    return {"samples": samples, "n": len(samples), "mean": statistics.mean(samples), "min": min(samples), "max": max(samples)}


def peak_rss():
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return rss if sys.platform == "darwin" else rss * 1024


if __name__ == "__main__":
    print(json.dumps(main(sys.argv[1] if len(sys.argv) > 1 else "suite")), flush=True)
