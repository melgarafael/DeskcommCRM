"""Exclusão da bancada acompanha o trabalho, inclusive após a morte do console."""
import fcntl
import json
import os
import signal
import selectors
import time
import stat
import subprocess
import sys

area, root, probe, node, worker, timeout = sys.argv[1:]
fd = os.open(os.path.join(area, 'probe.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
info = os.fstat(fd)
if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
    sys.exit(74)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(73)
# Supervisor morto à força: não inferir que seus descendentes terminaram e não
# matar um PID vindo de disco. O arquivo fica reservado para inspeção manual.
if os.read(fd, 4096):
    sys.exit(73)

def mark(value):
    os.lseek(fd, 0, os.SEEK_SET)
    os.ftruncate(fd, 0)
    if value:
        os.write(fd, json.dumps(value).encode())
    os.fsync(fd)

mark({'purpose': 'extensions-probe-reservation', 'repo_root': root, 'id': probe})
child = None
cancelled = False

def cancel(_signum, _frame):
    global cancelled
    cancelled = True
    # Só o grupo criado por este Popen, cujo líder ainda não foi colhido.
    if child is not None and child.returncode is None:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

signal.signal(signal.SIGTERM, cancel)
signal.signal(signal.SIGINT, cancel)
with os.fdopen(3, 'w') as ready:
    ready.write('locked\n')
    ready.flush()
# A reserva vem antes da persistência do aceite. EOF antes de "run" não executa.
if sys.stdin.readline().strip() != 'run' or cancelled:
    mark(None)
    sys.exit(0)
try:
    child = subprocess.Popen([node, worker, probe, str(fd)], cwd=root, start_new_session=True,
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, pass_fds=(fd,))
    if cancelled:
        cancel(None, None)
    stdout, stderr = bytearray(), bytearray()
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    selector.register(child.stderr, selectors.EVENT_READ)
    deadline = time.monotonic() + float(timeout)
    failure = b''
    while selector.get_map():
        if not cancelled and time.monotonic() >= deadline:
            failure = b'\nA prova excedeu o limite da bancada; seu grupo foi encerrado.\n'
            cancel(None, None)
        for key, _ in selector.select(0.05):
            chunk = key.fileobj.read1(65536)
            if not chunk:
                selector.unregister(key.fileobj)
                continue
            if key.fileobj is child.stdout:
                if len(stdout) + len(chunk) > 2 * 1024 * 1024:
                    failure = b'\nRelatorio excedeu o limite da bancada.\n'
                    cancel(None, None)
                elif not cancelled:
                    stdout.extend(chunk)
            else:
                stderr = (stderr + chunk)[-16000:]
    selector.close()
    child.wait()
    stderr.extend(failure)
    # O processo terminou e seus pipes fecharam. Falha anormal conserva a reserva:
    # um descendente com stdio próprio pode continuar mesmo depois do runner morrer.
    if child.returncode == 0 or cancelled:
        mark(None)
    try:
        sys.stdout.buffer.write(stdout)
        sys.stdout.buffer.flush()
        sys.stderr.buffer.write(stderr)
        sys.stderr.buffer.flush()
    except BrokenPipeError:
        os._exit(0 if child.returncode == 0 else 1)
    sys.exit(0 if child.returncode == 0 and not cancelled else 1)
except OSError:
    # Spawn falhou sem criar processo: não há trabalho a proteger.
    if child is None:
        mark(None)
    raise
