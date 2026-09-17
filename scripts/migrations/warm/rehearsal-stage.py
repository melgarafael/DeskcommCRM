"""Carrega o arquivo SOMENTE no laboratório sem rede; não converte tabelas operacionais.

Uso na VPS de destino: python3 rehearsal-stage.py /diretorio-privado/lote.tar.gz
O administrador e o contêiner fixados existem apenas no ensaio. Não aceitar parâmetros
de conexão evita direcionar acidentalmente esta carga experimental para produção.
"""
import csv
import hashlib
import io
import json
import pathlib
import re
import subprocess
import sys
import tarfile

CONTAINER = 'warm-migration-rehearsal-v3'
SOURCE = '68e16519-dac1-4e28-8762-615528a71180'
TARGET = '4939e89d-2f77-465e-97c5-5236cf07b57b'
SCHEMA = 'warm_rehearsal_20260914'
PG = ['docker', 'exec', '-i', CONTAINER, 'psql', '-h', '/tmp', '-U', 'warm_rehearsal_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At']


def execute(sql):
    result = subprocess.run(PG, input=sql, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError('Falha SQL no laboratório; saída privada não publicada')
    return result.stdout.strip()


def main():
    archive_path = pathlib.Path(sys.argv[1]).resolve(strict=True)
    network = subprocess.check_output(['docker', 'inspect', CONTAINER, '--format', '{{.HostConfig.NetworkMode}}'], text=True).strip()
    if network != 'none':
        raise RuntimeError('Laboratório não está isolado')
    if execute('select current_user;') != 'warm_rehearsal_admin':
        raise RuntimeError('Administrador do ensaio divergente')
    with tarfile.open(archive_path, 'r:gz') as archive:
        members = archive.getmembers()
        manifests = [m for m in members if m.name.endswith('/manifest.json')]
        if len(manifests) != 1:
            raise RuntimeError('Manifesto inválido')
        prefix = manifests[0].name.removesuffix('manifest.json')
        if any(not (m.isdir() and m.name.rstrip('/') == prefix.rstrip('/')) and not (m.isfile() and m.name.startswith(prefix) and re.fullmatch(r'(?:[a-z_]+\.ndjson|manifest\.json)', m.name[len(prefix):])) for m in members):
            raise RuntimeError('Conteúdo inesperado no arquivo')
        raw_manifest = archive.extractfile(manifests[0]).read()
        manifest = json.loads(raw_manifest)
        if manifest['workspace_id'] != SOURCE or manifest['purpose'] != 'isolated-rehearsal':
            raise RuntimeError('Lote fora do contrato')
        manifest_hash = hashlib.sha256(raw_manifest).hexdigest()
        existing = execute(f"select to_regclass('{SCHEMA}.batches') is not null;")
        if existing == 't':
            previous = execute(f"select manifest_hash from {SCHEMA}.batches where id='warm-20260914-b' and state='staged';")
            if previous == manifest_hash:
                print(json.dumps({'idempotent_replay': True, 'new_rows': 0}))
                return
            raise RuntimeError('Laboratório contém outro lote; nenhuma sobrescrita permitida')
        csv_path = archive_path.parent / 'stage-private.csv'
        counts = {}
        with csv_path.open('x', encoding='utf-8', newline='') as output:
            csv_path.chmod(0o600)
            writer = csv.writer(output)
            for table, metadata in manifest['tables'].items():
                if not re.fullmatch('[a-z_]+', table):
                    raise RuntimeError('Tabela inválida')
                seen = set()
                with archive.extractfile(prefix + table + '.ndjson') as data:
                    for raw_line in data:
                        row = json.loads(raw_line)
                        if row.get('workspace_id', SOURCE) != SOURCE:
                            raise RuntimeError('Workspace divergente no conteúdo')
                        source_id = row.get('id', row.get('workspace_id'))
                        if not source_id or source_id in seen:
                            raise RuntimeError('Identidade ausente ou repetida')
                        seen.add(source_id)
                        writer.writerow([TARGET, SOURCE, table, source_id, json.dumps(row, ensure_ascii=False, separators=(',', ':'))])
                counts[table] = len(seen)
                if counts[table] != metadata['count']:
                    raise RuntimeError('Contagem diverge do manifesto')
    subprocess.run(['docker', 'cp', str(csv_path), CONTAINER + ':/tmp/stage-private.csv'], check=True, capture_output=True)
    subprocess.run(['docker', 'exec', '-u', 'root', CONTAINER, 'chown', 'postgres:postgres', '/tmp/stage-private.csv'], check=True, capture_output=True)
    sql = f"""
begin;
create schema {SCHEMA} authorization warm_rehearsal_admin;
revoke all on schema {SCHEMA} from public, anon, authenticated, service_role;
create table {SCHEMA}.batches (
 id text primary key, organization_id uuid not null references public.organizations(id),
 manifest_hash text not null, state text not null, imported_at timestamptz not null default now()
);
create table {SCHEMA}.records (
 organization_id uuid not null references public.organizations(id), source_workspace_id uuid not null,
 source_table text not null, source_id text not null, payload jsonb not null,
 primary key (organization_id,source_table,source_id),
 check (organization_id='{TARGET}'::uuid and source_workspace_id='{SOURCE}'::uuid),
 check (not (payload ? 'workspace_id') or payload->>'workspace_id'='{SOURCE}')
);
alter table {SCHEMA}.batches enable row level security;
alter table {SCHEMA}.batches force row level security;
alter table {SCHEMA}.records enable row level security;
alter table {SCHEMA}.records force row level security;
revoke all on all tables in schema {SCHEMA} from public,anon,authenticated,service_role;
copy {SCHEMA}.records from '/tmp/stage-private.csv' with (format csv);
insert into {SCHEMA}.batches values ('warm-20260914-b','{TARGET}','{manifest_hash}','staged',now());
commit;
"""
    execute(sql)
    actual = dict(line.split('|') for line in execute(f'select source_table,count(*) from {SCHEMA}.records group by source_table;').splitlines())
    if any(int(actual.get(table, 0)) != count for table, count in counts.items()):
        raise RuntimeError('Reconciliação de staging reprovada')
    access = {}
    for role in ['anon', 'authenticated', 'service_role']:
        result = subprocess.run(PG, input=f'set role {role}; select count(*) from {SCHEMA}.records;', text=True, capture_output=True)
        access[role] = result.returncode != 0 and 'permission denied' in result.stderr
    if not all(access.values()):
        raise RuntimeError('Acesso ao arquivo de ensaio não foi negado')
    report = {'staged_records': sum(counts.values()), 'tables': len(counts), 'counts_match': True,
              'application_roles_denied': access, 'network': network, 'production_imported': False,
              'operational_conversion_complete': False, 'manifest_hash': manifest_hash}
    (archive_path.parent / 'stage-verification.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))


if __name__ == '__main__':
    main()
