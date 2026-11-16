#!/usr/bin/env python3
"""Prepare matching image-library sources and notices; never execute upstream code."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

repo = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
parser.add_argument('--proxy')
args = parser.parse_args()
output = Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=True)
spec = json.loads((repo / 'apps/homebrew/licenses/image-library-sources.json').read_text())

def fetch(item):
    target = output / item['file']
    if not target.exists():
        temporary = target.with_suffix(target.suffix + '.partial')
        command = ['curl', '--fail', '--location', '--silent', '--show-error', '--retry', '1', '--max-time', '600', '--continue-at', '-']
        if args.proxy:
            command += ['--proxy', args.proxy]
        command += [item['url'], '--output', str(temporary)]
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode and ('byte ranges' in result.stderr or 'Cannot resume' in result.stderr):
            # GitHub codeload cannot resume; restart this incomplete archive only.
            index = command.index('--continue-at')
            command[index:index + 2] = []
            result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError('download failed: curl exit ' + str(result.returncode))
        temporary.rename(target)
    return {**item, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'bytes': target.stat().st_size}

records, failures = [], []
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    pending = {pool.submit(fetch, item): item for item in spec['sources']}
    for future in concurrent.futures.as_completed(pending):
        item = pending[future]
        try:
            result = future.result()
            records.append(result)
            print('OK', item['name'], result['bytes'], flush=True)
        except Exception as error:
            failures.append(item['name'])
            print('FAILED', item['name'], str(error), flush=True)

receipt = {'schema': 1, 'upstream': spec['upstream'], 'complete': False,
           'sources': sorted(records, key=lambda item: item['file']), 'failed': failures}
(output / 'source-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
if failures:
    raise SystemExit('Source bundle incomplete; rerun to retry failed downloads.')

notices = output / 'notices'
notices.mkdir(exist_ok=True)
for record in records:
    archive = output / record['file']
    if record['file'].endswith('.patch'):
        continue
    with tarfile.open(archive, 'r:*') as source:
        for member in source.getmembers():
            name = Path(member.name).name
            if not member.isfile() or member.size > 2 * 1024 * 1024:
                continue
            if not re.match(r'^(LICEN[CS]E|COPYING|COPYRIGHT|NOTICE|FTL\.TXT)', name, re.I):
                continue
            # Read archive members as bytes only: no extraction, links, or upstream execution.
            file_id = hashlib.sha256(member.name.encode()).hexdigest()[:10]
            (notices / (record['file'][:2] + '-' + file_id + '-' + name)).write_bytes(source.extractfile(member).read())
shutil.copytree(repo / 'apps/homebrew/licenses/sharp-libvips-build', output / 'build-recipe', dirs_exist_ok=True)
receipt['complete'] = True
(output / 'source-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print('Source bundle complete:', output, flush=True)
