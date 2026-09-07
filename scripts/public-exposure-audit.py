#!/usr/bin/env python3
"""Read-only GitHub snapshot scan. Raw content and denylist values never enter reports."""
import base64
from collections import Counter
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile

MAX_FILE = 100_000_000
MAX_TOTAL = 2_000_000_000


class AuditError(Exception):
    pass


class Scanner:
    def __init__(self, denylist):
        self.tokens = [s.strip().lower().encode() for s in re.split(r'[\n,]', denylist) if s.strip()]
        if not self.tokens:
            raise AuditError('Private denylist is required')
        self.counts = Counter()
        self.findings = []
        self.total = 0

    def scan(self, location, data):
        if len(data) > MAX_FILE or self.total + len(data) > MAX_TOTAL:
            raise AuditError('Scan size limit exceeded')
        self.total += len(data)
        self.counts['files'] += 1
        for number, line in enumerate(data.split(b'\n'), 1):
            if any(token in line.lower() for token in self.tokens):
                self.findings.append({'location': location, 'line': number})

    def archive(self, location, data, kind='zip', depth=0):
        if len(data) > MAX_FILE or depth > 3:
            raise AuditError('Archive limit exceeded')
        self.counts['archives'] += 1
        if kind == 'zip':
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                self.scan(location + '/comment', archive.comment)
                for index, member in enumerate(archive.infolist()):
                    self.scan(f'{location}/entry-{index}/metadata', member.comment + member.extra)
                    if member.is_dir():
                        self.scan(f'{location}/entry-{index}/name', member.filename.encode())
                        continue
                    if member.file_size > MAX_FILE or member.file_size + self.total > MAX_TOTAL:
                        raise AuditError('Archive member limit exceeded')
                    name = member.filename
                    self.member(f'{location}/entry-{index}', name, archive.read(member), depth)
        else:
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
                for index, member in enumerate(archive):
                    metadata = {'user': member.uname, 'group': member.gname, 'pax': member.pax_headers}
                    self.scan(f'{location}/entry-{index}/metadata', json.dumps(metadata).encode())
                    if member.isdir():
                        self.scan(f'{location}/entry-{index}/name', member.name.encode())
                        continue
                    if not member.isfile():
                        raise AuditError('Unsupported archive member type')
                    if member.size > MAX_FILE or member.size + self.total > MAX_TOTAL:
                        raise AuditError('Archive member limit exceeded')
                    self.member(f'{location}/entry-{index}', member.name,
                                archive.extractfile(member).read(), depth)

    def member(self, location, name, data, depth):
        # Do not extract names onto disk or expose them in the report.
        self.scan(location + '/name', name.encode())
        if name.endswith(('.tgz', '.tar.gz')):
            self.archive(location, data, 'tar', depth + 1)
        elif name.endswith('.zip'):
            self.archive(location, data, 'zip', depth + 1)
        else:
            self.scan(location, data)


def command(args, cwd=None, env=None):
    child_env = dict(os.environ if env is None else env)
    child_env.pop('LEAK_DENYLIST', None)
    result = subprocess.run(args, cwd=cwd, env=child_env, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=180)
    if result.returncode:
        # API error bodies, Git messages and remote filenames may contain private context.
        raise AuditError('Read command failed; no response content was logged')
    return result.stdout


class Github:
    def __init__(self, repository):
        if not re.fullmatch(r'[\w.-]+/[\w.-]+', repository):
            raise AuditError('Invalid repository identifier')
        self.prefix = 'repos/' + repository

    def get(self, route):
        return json.loads(command(['gh', 'api', self.prefix + route]))

    def pages(self, route, key=None):
        separator = '&' if '?' in route else '?'
        pages = json.loads(command(['gh', 'api', '--paginate', '--slurp',
                                    self.prefix + route + separator + 'per_page=100']))
        rows = [row for page in pages for row in (page[key] if key else page)]
        if key and pages and pages[0].get('total_count', len(rows)) > len(rows):
            raise AuditError('API inventory was truncated')
        return rows

    def download(self, route):
        return command(['gh', 'api', self.prefix + route])


def scan_texts(scanner, rows, kind):
    for index, row in enumerate(rows):
        for field in ('title', 'body', 'name', 'tag_name'):
            value = row.get(field)
            if isinstance(value, str):
                scanner.scan(f'{kind}/{index}/{field}', value.encode())
                # Attachments require a separate content/visual review, not a silent omission.
                if re.search(r'https?://[^\s<>]*?(user-attachments|user-images\.githubusercontent|/assets/)', value):
                    raise AuditError('Linked attachments require additional review')


def scan_git(scanner, repository, tips):
    with tempfile.TemporaryDirectory() as folder:
        command(['git', 'init', '--bare', '--quiet', folder])
        env = dict(os.environ)
        token = env.get('GH_TOKEN', '')
        if not token:
            raise AuditError('GitHub read token is required')
        credential = base64.b64encode(('x-access-token:' + token).encode()).decode()
        env.update(GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='http.https://github.com/.extraheader',
                   GIT_CONFIG_VALUE_0='AUTHORIZATION: basic ' + credential,
                   GIT_TERMINAL_PROMPT='0')
        remote = 'https://github.com/' + repository + '.git'
        command(['git', 'fetch', '--quiet', remote,
                 '+refs/heads/*:refs/audit/heads/*', '+refs/tags/*:refs/tags/*',
                 '+refs/pull/*/head:refs/audit/pulls/*'], folder, env)
        for tip in sorted(tips):
            if not re.fullmatch(r'[0-9a-f]{40}', tip):
                raise AuditError('Invalid commit identifier')
            command(['git', 'fetch', '--quiet', '--no-tags', remote, tip], folder, env)
        scanner.scan('git/ref-names', command(['git', 'for-each-ref', '--format=%(refname)'], folder))
        objects = command(['git', 'cat-file', '--batch-all-objects',
                           '--batch-check=%(objectname) %(objecttype) %(objectsize)'], folder)
        for record in objects.decode().splitlines():
            oid, kind, size = record.split()
            if int(size) > MAX_FILE:
                raise AuditError('Git object limit exceeded')
            scanner.scan(f'git/{kind}/{oid}', command(['git', 'cat-file', kind, oid], folder))
            scanner.counts['git_' + kind] += 1


def audit(scanner, repository, current_run, report):
    api = Github(repository)
    metadata = api.get('')
    report['visibility'] = metadata['visibility']
    # These surfaces need their own collector if enabled; do not silently claim coverage.
    if any(metadata.get(key) for key in ('has_wiki', 'has_discussions', 'has_pages')):
        raise AuditError('Wiki, Discussions or Pages require additional review')
    scanner.scan('repository/description', (metadata.get('description') or '').encode())
    pulls = api.pages('/pulls?state=all')
    runs = api.pages('/actions/runs', 'workflow_runs')
    report['pull_numbers'] = [p['number'] for p in pulls]
    report['run_ids'] = [r['id'] for r in runs]
    tips = {r['head_sha'] for r in runs}
    for pull in pulls:
        tips.update(pull[key]['sha'] for key in ('head', 'base'))
        if pull.get('merge_commit_sha'):
            tips.add(pull['merge_commit_sha'])
        scan_texts(scanner, api.pages(f"/pulls/{pull['number']}/reviews"),
                   f"pull-reviews/{pull['number']}")
    scan_texts(scanner, pulls, 'pulls')
    for route in ('/issues?state=all', '/issues/comments', '/pulls/comments', '/comments', '/releases'):
        rows = api.pages(route)
        scan_texts(scanner, rows, route.split('?')[0].strip('/'))
        if route == '/releases' and any(row.get('assets') for row in rows):
            raise AuditError('Release assets require additional review')
    report['referenced_tips'] = sorted(tips)
    scan_git(scanner, repository, tips)
    report['log_attempts'] = []
    report['excluded_current_run'] = current_run
    # Let the source CI running alongside this PR complete before collecting its logs.
    deadline = time.monotonic() + 480
    for run in runs:
        own_run = str(run['id']) == current_run
        while not own_run and run['status'] != 'completed':
            if time.monotonic() >= deadline:
                raise AuditError('Another inventoried workflow is still running')
            time.sleep(5)
            run = api.get(f"/actions/runs/{run['id']}")
        attempts = run.get('run_attempt', 1)
        for attempt in range(1, attempts + (0 if own_run else 1)):
            location = f"logs/{run['id']}/{attempt}"
            scanner.archive(location, api.download(f"/actions/runs/{run['id']}/attempts/{attempt}/logs"))
            report['log_attempts'].append({'run': run['id'], 'attempt': attempt})
    artifacts = api.pages('/actions/artifacts', 'artifacts')
    report['artifact_ids'] = []
    report['expired_artifact_ids'] = []
    for artifact in artifacts:
        if artifact['expired']:
            report['expired_artifact_ids'].append(artifact['id'])
            continue
        if artifact['size_in_bytes'] > MAX_FILE:
            raise AuditError('Artifact limit exceeded')
        scanner.archive(f"artifacts/{artifact['id']}",
                        api.download(f"/actions/artifacts/{artifact['id']}/zip"))
        report['artifact_ids'].append(artifact['id'])
    if report['expired_artifact_ids']:
        raise AuditError('Expired artifacts require separate retained-snapshot evidence')


def main():
    report = {'started_at': datetime.now(timezone.utc).isoformat(), 'complete': False,
              'scope': 'API-listed refs, PR text, run attempts and available artifacts at collection time; current audit run and unknown orphaned objects excluded'}
    scanner = None
    try:
        scanner = Scanner(os.environ.get('LEAK_DENYLIST', ''))
        audit(scanner, os.environ.get('GITHUB_REPOSITORY', ''), os.environ.get('GITHUB_RUN_ID', ''), report)
        report['complete'] = True
    except AuditError as error:
        report['error'] = str(error)
    except Exception:
        report['error'] = 'Audit failed; response and exception contents were withheld'
    if scanner:
        report.update(counts=dict(scanner.counts), bytes_scanned=scanner.total, findings=scanner.findings)
    report['finished_at'] = datetime.now(timezone.utc).isoformat()
    output = Path(os.environ.get('AUDIT_REPORT', 'audit-report.json'))
    output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'complete': report['complete'], 'counts': report.get('counts', {}),
                      'findings': len(report.get('findings', [])), 'error': report.get('error')}))
    return 0 if report['complete'] and not report.get('findings') else 1


if __name__ == '__main__':
    sys.exit(main())
