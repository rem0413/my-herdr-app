"""Run with python3 mods/workspace-agents/omp-reader-check.py."""
import importlib.util
import json
from pathlib import Path
import tempfile
import sys

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('reader', Path(__file__).with_name('omp-reader.py'))
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)

with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / 'Child.jsonl'
    records = [
        {'type': 'session', 'parentSession': '/root.jsonl'},
        {'type': 'session_init', 'agent': 'reviewer', 'task': 'Review auth'},
        {'type': 'message', 'message': {'role': 'user', 'content': []}},
    ]
    path.write_text(''.join(json.dumps(r) + '\n' for r in records))
    state = reader.consume(path, None)
    assert state['parentSession'] == '/root.jsonl' and state['role'] == 'reviewer'
    assert state['status'] == 'working'
    root = Path(directory) / 'root.jsonl'
    children = root.with_suffix('')
    children.mkdir()
    child = children / 'AuthReview.jsonl'
    child_records = [{**records[0], 'parentSession': str(root)}, *records[1:]]
    child.write_text(''.join(json.dumps(r) + '\n' for r in child_records))
    visible = reader.scan({'roots': {str(root): 't1'}, 'files': {}})
    assert [(node['name'], node['parent']) for node in visible['nodes']] == [('AuthReview', 't1')]
    ending = json.dumps({'type': 'message', 'message': {'role': 'assistant', 'stopReason': 'stop', 'content': [{'type': 'text', 'text': 'Auth checked'}]}})
    with path.open('a') as stream:
        stream.write(ending[:20])
    partial = reader.consume(path, state)
    assert partial == state, 'Incomplete JSONL must remain unread'
    with path.open('a') as stream:
        stream.write(ending[20:] + '\n')
    done = reader.consume(path, partial)
    assert done['status'] == 'done'
    assert reader.consume(path, done) == done, 'Unchanged file must preserve offset and state'
    with child.open('a') as stream:
        stream.write(ending + '\n')
    finished = reader.scan({'roots': {str(root): 't1'}, 'files': visible['files']})
    assert finished['nodes'] == [], 'Completed children must disappear from Agents'
    path.write_text(json.dumps(records[2]) + '\n')
    assert reader.consume(path, done)['status'] == 'working', 'Truncated file must reset cursor'
print('OMP reader checks passed')
