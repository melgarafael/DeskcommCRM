#!/usr/bin/env bash
# Tipos do schema REAL que o CI acabou de instalar; nunca escreve no arquivo gerado do produto.
set -euo pipefail

[ "${GITHUB_ACTIONS:-}" = true ] || { echo "Use somente no banco descartável do E2E no CI." >&2; exit 1; }
destino="${1:?uso: $0 evidencia-gerada/tipos-do-banco <tabela>...}"
shift
[ "$#" -gt 0 ] || { echo "Declare as tabelas que esta prova precisa encontrar." >&2; exit 1; }
case "$destino" in evidencia-gerada/tipos-do-banco) ;; *) echo "Destino de artefato inesperado." >&2; exit 1 ;; esac

mkdir -p "$destino"
temporario="$(mktemp "$destino/tipos.XXXXXX")"
trap 'rm -f "$temporario"' EXIT
# O CLI da stack pode ser anterior ao suporte a campos computados. Só esta
# coleta usa o gerador fixado, sem trocar a versão que sobe o Supabase.
tipos_cli_versao="2.122.0"
gerador=(npm exec --yes "--package=supabase@${tipos_cli_versao}" -- supabase)
tipos_cli_observada="$("${gerador[@]}" --version)"
[ "$tipos_cli_observada" = "$tipos_cli_versao" ] || { echo "Versão inesperada do gerador de tipos." >&2; exit 1; }
# A URL é a do banco sintético fixo deste workflow; não há .env ou credencial de cliente.
# TLS só é desligado depois de conferir o destino numérico local exato.
tipos_db_url="$(node <<'JS'
const url = new URL("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "54322" || url.pathname !== "/postgres") {
  throw new Error("Destino do gerador não é o banco descartável local esperado.");
}
url.searchParams.set("sslmode", "disable");
process.stdout.write(url.toString());
JS
)"
"${gerador[@]}" gen types --lang typescript \
  --db-url "$tipos_db_url" \
  --schema public > "$temporario"
test -s "$temporario"
for tabela in "$@"; do
  case "$tabela" in *[!a-z_0-9]*|'') echo "Nome de tabela inválido." >&2; exit 1 ;; esac
done
# O 2.122 emite chaves citadas e pode pôr tabelas na mesma linha. A AST mede
# Tables de verdade, sem confundir uma referência de FK com tabela presente.
node - "$temporario" "$@" <<'JS'
const fs = require("node:fs");
const ts = require("typescript");
const [arquivo, ...exigidas] = process.argv.slice(2);
const sf = ts.createSourceFile("tipos.ts", fs.readFileSync(arquivo, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
if (sf.parseDiagnostics.length) throw new Error("Saída de tipos inválida.");
const nome = (m) => m.name?.text;
const database = sf.statements.find((s) => ts.isTypeAliasDeclaration(s) && s.name.text === "Database");
const publico = database?.type.members?.find((m) => nome(m) === "public");
const tabelas = publico?.type.members?.find((m) => nome(m) === "Tables")?.type.members;
if (!tabelas) throw new Error("Schema public.Tables ausente.");
for (const tabela of new Set([...exigidas, "lead_field_proposals"])) {
  if (!tabelas.some((m) => nome(m) === tabela)) throw new Error(`Tabela exigida ausente: ${tabela}`);
}
const conversa = tabelas.find((m) => nome(m) === "conversations");
const row = conversa?.type.members?.find((m) => nome(m) === "Row")?.type.members;
if (!row?.some((m) => nome(m) === "tags_do_contato")) throw new Error("Campo computado conversations.Row.tags_do_contato ausente.");
JS
mv "$temporario" "$destino/database.types.ts"
python3 - "$destino" "$tipos_cli_observada" "$@" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

destino = Path(sys.argv[1])
prova = {
    "synthetic": True,
    "schema": "public",
    "generator_version": sys.argv[2],
    "database": "Supabase descartável do E2E em 127.0.0.1:54322",
    "tree_sha": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
    "candidate_sha": os.environ.get("CANDIDATO_SHA"),
    "run_id": os.environ.get("GITHUB_RUN_ID"),
    "baseline_sha256": hashlib.sha256(Path("supabase/baseline.sql").read_bytes()).hexdigest(),
    "types_sha256": hashlib.sha256((destino / "database.types.ts").read_bytes()).hexdigest(),
    "tables_required": sys.argv[3:] + ["lead_field_proposals"],
    "computed_fields_required": ["conversations.tags_do_contato"],
    "product_generated_file_modified": False,
}
(destino / "origem.json").write_text(json.dumps(prova, indent=2) + "\n")
PY
