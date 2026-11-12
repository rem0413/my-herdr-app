"""Read native OMP children without changing or launching agent sessions."""
import json
from pathlib import Path
import subprocess
import sys


def consume(path, previous):
    state = dict(previous or {})
    offset = state.get('offset', 0)
    with path.open('rb') as stream:
        if path.stat().st_size < offset:
            state, offset = {}, 0
        stream.seek(offset)
        data = stream.read()
    complete = data.rfind(b'\n') + 1
    for line in data[:complete].splitlines():
        try:
            record = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            continue
        if not isinstance(record, dict):
            continue
        kind = record.get('type')
        if kind == 'session':
            state['parentSession'] = record.get('parentSession')
        elif kind == 'session_init':
            state['role'] = record.get('agent', 'task')
            state['task'] = record.get('task', '')
        elif kind == 'message':
            message = record.get('message')
            if not isinstance(message, dict):
                continue
            if message.get('role') == 'assistant':
                stop = message.get('stopReason')
                state['status'] = 'done' if stop == 'stop' else 'blocked' if stop == 'error' else 'working'
            elif message.get('role') == 'user':
                state['status'] = 'working'
    state['offset'] = offset + complete
    return state


def discover(addresses):
    roots = {}
    for address in addresses:
        if '/' in address:
            continue
        # One terminal that can't be read is skipped; it must not hide every other agent's children.
        try:
            result = subprocess.run(['hc', 'get', address], capture_output=True, text=True, timeout=10)
            if result.returncode:
                continue
            pid = (json.loads(result.stdout).get('foreground') or {}).get('pid')
            if not isinstance(pid, int):
                continue
            opened = subprocess.run(['/usr/sbin/lsof', '-nP', '-b', '-a', '-p', str(pid), '-Fn'], capture_output=True, text=True, timeout=10)
        except (OSError, ValueError, AttributeError, subprocess.TimeoutExpired):
            continue
        for line in opened.stdout.splitlines():
            if not line.startswith('n') or not line.endswith('.jsonl'):
                continue
            path = Path(line[1:])
            if '/sessions/' not in str(path):
                continue
            try:
                if not path.stem[:4].isdigit():
                    continue
                with path.open('rb') as stream:
                    header = json.loads(stream.readline())
                    if header.get('type') == 'title':
                        header = json.loads(stream.readline())
                if header.get('type') == 'session' and not header.get('parentSession'):
                    roots[str(path)] = address
            # A session file whose first line isn't written yet is looked at again next time.
            except (OSError, ValueError, AttributeError):
                continue
    return roots


def scan(request):
    roots = discover(request['addresses']) if request.get('discover') else request.get('roots', {})
    old = request.get('files', {})
    files, nodes = {}, []
    for root, address in roots.items():
        directory = Path(root).with_suffix('')
        if not directory.is_dir():
            continue
        for path in directory.rglob('*.jsonl'):
            try:
                info = consume(path, old.get(str(path)))
            except OSError:
                continue
            files[str(path)] = info
            parent = info.get('parentSession')
            if not parent or not info.get('role') or info.get('status') != 'working':
                continue
            parent_address = address if parent == root else 'omp:' + parent
            nodes.append({'address': 'omp:' + str(path), 'parent': parent_address,
                          'name': path.stem, 'task': info.get('task', ''),
                          'status': info.get('status', 'unknown'), 'state': 'live', 'transcript': str(path)})
    return {'roots': roots, 'files': files, 'nodes': nodes}




if __name__ == '__main__':
    try:
        # argv[1]: a file holding the request (it can be large, and argv shows in ps), or the
        # request itself when run on another machine, where the mod can't write a file.
        arg = sys.argv[1]
        request = json.loads(arg if arg.startswith('{') else Path(arg).read_text())
        print(json.dumps(scan(request)))
    except Exception as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)
