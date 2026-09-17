"""Ensaio isolado por padrão; apply-native.py habilita a carga com gates adicionais."""
import csv
import gzip
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import time

CONTAINER = 'warm-migration-rehearsal-v3'
TARGET = '4939e89d-2f77-465e-97c5-5236cf07b57b'
BATCH = '6f40c48b-397f-5a31-aafe-ed82a6023979'
TABLES = ['contacts', 'channel_sessions', 'conversations', 'messages', 'message_attachments', 'crm_pipelines', 'crm_stages', 'crm_leads', 'conversation_notes', 'crm_tasks', 'calendar_appointments', 'data_import_records', 'data_import_record_contacts']


def main(production=False):
    container = 'crm-supabase-db' if production else CONTAINER
    pg = ['docker', 'exec', '-i', container, 'psql']
    if not production:
        pg.extend(['-h', '/tmp'])
    pg.extend(['-U', 'supabase_admin' if production else 'warm_rehearsal_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'])
    path = pathlib.Path(sys.argv[1]).resolve(strict=True)
    manifest_path = pathlib.Path(str(path).removesuffix('.gz') + '.manifest.json')
    manifest = json.loads(manifest_path.read_text())
    with (gzip.open(path, 'rb') if path.suffix == '.gz' else path.open('rb')) as stream:
        artifact_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
    if manifest['native_sha256'] != artifact_hash or manifest['source_workspace_id'] != '68e16519-dac1-4e28-8762-615528a71180' or manifest['batch_id'] != BATCH:
        raise RuntimeError('Manifesto não corresponde ao artefato')
    cutoff = manifest['source_cutoff']
    if not re.fullmatch(r'[0-9T:.Z+-]+', cutoff):
        raise RuntimeError('Corte inválido')
    network = subprocess.check_output(['docker', 'inspect', container, '--format', '{{.HostConfig.NetworkMode}}'], text=True).strip()
    if not production and network != 'none':
        raise RuntimeError('Laboratório não isolado')
    if production:
        rehearsal = json.loads((path.parent / 'native-rehearsal-report.json').read_text())
        if rehearsal.get('passed') is not True or rehearsal.get('native_sha256') != artifact_hash:
            raise RuntimeError('Artefato não aprovado no ensaio')
        media = json.loads((path.parent / 'media-upload-report.json').read_text())
        if media.get('passed') is not True or media.get('native_sha256') != artifact_hash:
            raise RuntimeError('Arquivos ainda não conferidos no Storage')
        backup = pathlib.Path(sys.argv[2]).resolve(strict=True)
        if backup.parent != pathlib.Path('/opt/deskcomm-crm/backups') or backup.suffix != '.dump' or time.time() - backup.stat().st_mtime > 3600:
            raise RuntimeError('Backup recente obrigatório')
        existing = subprocess.run(pg, input=f"select status||'|'||coalesce(manifest->>'native_sha256','') from public.data_import_batches where organization_id='{TARGET}' and id='{BATCH}';", text=True, capture_output=True, check=True).stdout.strip()
        if existing:
            if existing == 'completed|' + artifact_hash:
                print(json.dumps({'idempotent_replay': True, 'new_rows': 0, 'production_imported': True}))
                return
            raise RuntimeError('Lote existente diverge; nenhuma sobrescrita permitida')
    with (gzip.open(path, 'rt') if path.suffix == '.gz' else path.open()) as stream:
        data = json.load(stream)
    if set(data) != set(TABLES):
        raise RuntimeError('Contrato de tabelas divergente')
    statements = ["begin; set local statement_timeout='180s';",
        "create temp table import_safety_before as select (select count(*) from public.event_log) events,(select count(*) from public.cron_jobs) jobs,(select count(*) from auth.users) users;",
        f"insert into public.data_import_batches(id,organization_id,source,source_workspace_id,source_cutoff,status,manifest) values ('{BATCH}','{TARGET}','warm','68e16519-dac1-4e28-8762-615528a71180','{cutoff}','loading','{json.dumps(manifest).replace(chr(39), chr(39)*2)}');",
        f"set local crm.historical_import_batch='{BATCH}';",
        f"do $$ begin if not public.fn_historical_import_allowed('{TARGET}') then raise exception 'Historical guard rejected administrator'; end if; end $$;",
        "create temp table native_input(payload jsonb);",
    ]
    if production:
        # A instalação tem um único tenant de destino. Não substitui cadastros existentes.
        empty_tables = ['contacts', 'conversations', 'messages', 'crm_leads', 'crm_tasks', 'calendar_appointments']
        precondition = "do $$ begin " + ''.join(f"if exists(select 1 from public.{table} where organization_id='{TARGET}') then raise exception 'Target not empty: {table}'; end if; " for table in empty_tables) + "end $$;"
        statements.insert(1, 'lock table ' + ','.join('public.' + table for table in empty_tables) + ' in share row exclusive mode;')
        statements.insert(2, precondition)
    for table in TABLES:
        rows = data[table]
        if not rows:
            continue
        keys = sorted(set().union(*(r.keys() for r in rows)))
        if any(not re.fullmatch('[a-z_]+', key) for key in keys) or any(r['organization_id'] != TARGET for r in rows):
            raise RuntimeError('Conteúdo fora do contrato')
        csv_path = path.parent / f'native-{table}.csv'
        with csv_path.open('w', newline='') as output:
            csv_path.chmod(0o600)
            writer = csv.writer(output)
            for row in rows:
                writer.writerow([json.dumps(row, ensure_ascii=False)])
        subprocess.run(['docker', 'cp', str(csv_path), container + f':/tmp/native-{table}.csv'], check=True, capture_output=True)
        subprocess.run(['docker', 'exec', '-u', 'root', container, 'chown', 'postgres:postgres', f'/tmp/native-{table}.csv'], check=True, capture_output=True)
        columns = ','.join('"' + key + '"' for key in keys)
        selected = ','.join('r."' + key + '"' for key in keys)
        identity_join = "t.id=(i.payload->>'id')::uuid" if 'id' in keys else "t.record_id=(i.payload->>'record_id')::uuid and t.contact_id=(i.payload->>'contact_id')::uuid"
        statements.extend([
            'truncate native_input;',
            f"copy native_input from '/tmp/native-{table}.csv' with(format csv);",
            f'insert into public.{table}({columns}) select {selected} from native_input i cross join lateral jsonb_populate_record(null::public.{table},i.payload) r;',
            f"do $$ begin if (select count(*) from public.{table} t join native_input i on {identity_join} where t.organization_id='{TARGET}') <> {len(rows)} then raise exception 'Count mismatch {table}'; end if; end $$;",
        ])
    statements.extend([
        "do $$ begin if exists(select 1 from import_safety_before b where b.events<>(select count(*) from public.event_log) or b.jobs<>(select count(*) from public.cron_jobs) or b.users<>(select count(*) from auth.users)) then raise exception 'Historical import produced side effects'; end if; end $$;",
        f"do $$ begin if (select sum(value_cents) from public.crm_leads where organization_id='{TARGET}' and source='warm_import')<>1300000 or exists(select 1 from public.crm_leads where organization_id='{TARGET}' and source='warm_import' and currency is distinct from 'USD') then raise exception 'Deal currency reconciliation failed'; end if; end $$;",
        f"update public.data_import_batches set status='completed',completed_at=clock_timestamp() where id='{BATCH}' and organization_id='{TARGET}';",
        "select 'NATIVE_REHEARSAL_PASSED'; " + ('commit;' if production else 'rollback;'),
    ])
    result = subprocess.run(pg, input='\n'.join(statements), text=True, capture_output=True)
    # Erros podem incluir cadastro na linha que violou CHECK. Só o arquivo privado recebe isso.
    prefix = 'native-production' if production else 'native-rehearsal'
    log = path.parent / (prefix + '-private.log')
    log.write_text(result.stdout + '\n' + result.stderr)
    log.chmod(0o600)
    passed = result.returncode == 0 and 'NATIVE_REHEARSAL_PASSED' in result.stdout
    report = {'passed': passed, 'rollback': not production, 'production_imported': production and passed, 'native_sha256': artifact_hash, 'source_cutoff': cutoff, 'counts': {k: len(v) for k, v in data.items()}}
    (path.parent / (prefix + '-report.json')).write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
    if not passed:
        sys.exit(1)


if __name__ == '__main__':
    main()
