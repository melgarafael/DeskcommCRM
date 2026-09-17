"""Copia os binários auditados para o Storage privado e confere os bytes por GET.

Executar apenas na VPS de destino. Chave lida do processo da aplicação, mantida
em memória e enviada apenas ao gateway local. Não imprime URLs, nomes ou chaves.
"""
import concurrent.futures
import gzip
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

ORG = '4939e89d-2f77-465e-97c5-5236cf07b57b'
BASE = 'http://127.0.0.1:8020/storage/v1'


def main():
    artifact = pathlib.Path(sys.argv[1]).resolve(strict=True)
    directory = pathlib.Path(sys.argv[2]).resolve(strict=True)
    manifest = json.loads(pathlib.Path(str(artifact).removesuffix('.gz') + '.manifest.json').read_text())
    rehearsal = json.loads((artifact.parent / 'native-rehearsal-report.json').read_text())
    if rehearsal.get('passed') is not True or rehearsal.get('native_sha256') != manifest['native_sha256']:
        raise RuntimeError('Ensaio não corresponde ao artefato')
    with gzip.open(artifact, 'rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != manifest['native_sha256']:
            raise RuntimeError('Artefato alterado')
    with gzip.open(artifact, 'rt') as stream:
        data = json.load(stream)
    media = json.loads((directory / 'media-manifest-final.json').read_text())
    binaries = {row['sha256']: row for row in media['references'] if row['status'] == 'downloaded'}
    paths = set()
    for table in ['message_attachments', 'data_import_records']:
        for row in data[table]:
            if row.get('storage_path'):
                if row['organization_id'] != ORG:
                    raise RuntimeError('Arquivo de outro tenant')
                paths.add(row['storage_path'])
    del data
    batch = manifest['batch_id']
    for path in paths:
        if not re.fullmatch(ORG + r'/(?:[a-f0-9-]{36}|archive)/imports/' + batch + r'/[a-f0-9]{64}\.bin', path):
            raise RuntimeError('Caminho fora do lote')
        digest = path.rsplit('/', 1)[1].removesuffix('.bin')
        if digest not in binaries:
            raise RuntimeError('Binário não auditado')
    key = subprocess.check_output(['docker', 'exec', 'deskcomm-crm-app-1', 'node', '-e', "process.stdout.write(process.env.SUPABASE_SERVICE_ROLE_KEY||'')"], text=True).strip()
    if len(key) < 30:
        raise RuntimeError('Credencial local indisponível')
    headers = {'Authorization': 'Bearer ' + key, 'apikey': key}
    # urllib não pode seguir redirects levando o bearer para outro host.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, message, response_headers, new_url):
            return None
    opener = urllib.request.build_opener(NoRedirect)
    def fetch(path, method='GET', body=None, extra=None):
        request = urllib.request.Request(BASE + path, data=body, method=method, headers={**headers, **(extra or {})})
        return opener.open(request, timeout=180)
    try:
        with fetch('/bucket/whatsapp-media') as response:
            bucket = json.load(response)
            if bucket.get('public'):
                raise RuntimeError('Bucket deve ser privado')
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise RuntimeError('Falha ao consultar bucket') from None
        with fetch('/bucket', 'POST', json.dumps({'id': 'whatsapp-media', 'name': 'whatsapp-media', 'public': False}).encode(), {'Content-Type': 'application/json'}) as response:
            response.read()
    def upload(path):
        digest = path.rsplit('/', 1)[1].removesuffix('.bin')
        binary = binaries[digest]
        file = directory / (digest + '.bin')
        if not file.is_file() or file.stat().st_size != binary['bytes']:
            return {'ok': False, 'reason': 'local_size', 'path': path}
        with file.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != digest:
                return {'ok': False, 'reason': 'local_checksum', 'path': path}
        encoded = urllib.parse.quote('whatsapp-media/' + path, safe='/')
        try:
            exists = False
            try:
                with fetch('/object/info/' + encoded) as response:
                    response.read(); exists = True
            except urllib.error.HTTPError as error:
                if error.code not in [400, 404]:
                    raise
            if not exists:
                with file.open('rb') as stream, fetch('/object/' + encoded, 'POST', stream, {'Content-Length': str(binary['bytes']), 'Content-Type': binary.get('mime') or 'application/octet-stream', 'x-upsert': 'false'}) as response:
                    response.read()
            # Conferência ponta a ponta, inclusive na retomada: não confia só na metadata.
            with fetch('/object/authenticated/' + encoded) as response:
                check = hashlib.sha256(); size = 0
                while chunk := response.read(1024 * 1024):
                    check.update(chunk); size += len(chunk)
            if check.hexdigest() != digest or size != binary['bytes']:
                return {'ok': False, 'reason': 'remote_checksum', 'path': path}
            return {'ok': True, 'existing': exists}
        except urllib.error.HTTPError as error:
            return {'ok': False, 'reason': 'http_' + str(error.code), 'path': path}
        except Exception:
            return {'ok': False, 'reason': 'transport_or_io', 'path': path}
    failures = []; complete = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for result in pool.map(upload, sorted(paths)):
            complete += 1
            if not result['ok']:
                failures.append(result)
            if complete % 100 == 0:
                print(json.dumps({'verified': complete - len(failures), 'processed': complete, 'total': len(paths)}), flush=True)
    report = {'passed': not failures, 'native_sha256': manifest['native_sha256'], 'objects': len(paths), 'verified': complete-len(failures), 'failed': len(failures)}
    (artifact.parent / 'media-upload-report.json').write_text(json.dumps(report, indent=2))
    private = artifact.parent / 'media-upload-failures.json'
    private.write_text(json.dumps(failures, indent=2)); private.chmod(0o600)
    print(json.dumps(report))
    if failures:
        sys.exit(1)


if __name__ == '__main__':
    main()
