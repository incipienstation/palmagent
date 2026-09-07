#!/usr/bin/env python3
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('audit', Path(__file__).parents[1] / 'public-exposure-audit.py')
audit = importlib.util.module_from_spec(spec)
sys.dont_write_bytecode = True
spec.loader.exec_module(audit)


def zipped(name, data):
    result = io.BytesIO()
    with zipfile.ZipFile(result, 'w') as archive:
        archive.writestr(name, data)
    return result.getvalue()


class AuditTests(unittest.TestCase):
    def test_missing_denylist_fails_closed(self):
        for value in ('', ' , \n '):
            with self.assertRaises(audit.AuditError):
                audit.Scanner(value)

    def test_case_insensitive_matches_include_binary_and_only_report_locations(self):
        scanner = audit.Scanner('synthetic-sensitive-marker,second-marker')
        scanner.scan('git/blob/abc', b'ok\nSYNTHETIC-SENSITIVE-MARKER\n\0second-marker')
        self.assertEqual(scanner.findings, [{'location': 'git/blob/abc', 'line': 2},
                                            {'location': 'git/blob/abc', 'line': 3}])
        self.assertNotIn('marker', json.dumps(scanner.findings))

    def test_nested_archive_and_path_names_are_scanned_without_extraction(self):
        tar = io.BytesIO()
        with tarfile.open(fileobj=tar, mode='w:gz') as archive:
            member = tarfile.TarInfo('../../synthetic-sensitive-marker.txt')
            data = b'SYNTHETIC-SENSITIVE-MARKER'
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
        scanner = audit.Scanner('synthetic-sensitive-marker')
        scanner.archive('artifact/1', zipped('package.tgz', tar.getvalue()))
        self.assertEqual(len(scanner.findings), 2)
        self.assertNotIn('marker', json.dumps(scanner.findings))

    def test_symlinks_and_oversized_members_fail_closed(self):
        tar = io.BytesIO()
        with tarfile.open(fileobj=tar, mode='w:gz') as archive:
            member = tarfile.TarInfo('link')
            member.type = tarfile.SYMTYPE
            member.linkname = 'outside'
            archive.addfile(member)
        with self.assertRaises(audit.AuditError):
            audit.Scanner('marker').archive('archive', tar.getvalue(), 'tar')
        with patch.object(audit, 'MAX_FILE', 4):
            with self.assertRaises(audit.AuditError):
                audit.Scanner('marker').scan('blob', b'12345')

    def test_truncated_api_inventory_is_an_error(self):
        pages = json.dumps([{'total_count': 2, 'workflow_runs': [{'id': 1}]}]).encode()
        with patch.object(audit, 'command', return_value=pages):
            with self.assertRaises(audit.AuditError):
                audit.Github('example/project').pages('/actions/runs', 'workflow_runs')

    def test_subprocess_error_contents_are_withheld(self):
        result = subprocess.CompletedProcess([], 1, b'synthetic-private-value', b'synthetic-private-value')
        with patch.object(audit.subprocess, 'run', return_value=result):
            with self.assertRaises(audit.AuditError) as failure:
                audit.command(['git', 'status'])
        self.assertNotIn('synthetic-private-value', str(failure.exception))

    def test_unexpected_errors_produce_incomplete_redacted_report(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / 'report.json'
            with patch.dict(os.environ, {'LEAK_DENYLIST': 'synthetic-marker', 'AUDIT_REPORT': str(output)}):
                with patch.object(audit, 'audit', side_effect=RuntimeError('synthetic-private-value')):
                    stdout = io.StringIO()
                    with contextlib.redirect_stdout(stdout):
                        self.assertEqual(audit.main(), 1)
            report = output.read_text()
            self.assertFalse(json.loads(report)['complete'])
            self.assertNotIn('synthetic-private-value', report + stdout.getvalue())

    def test_all_prior_attempts_are_scanned_but_current_attempt_is_excluded(self):
        class FakeGithub:
            def __init__(self, repository):
                self.downloads = []

            def get(self, route):
                return {'visibility': 'private'}

            def pages(self, route, key=None):
                if route == '/actions/runs':
                    return [{'id': 1, 'status': 'completed', 'run_attempt': 2, 'head_sha': 'a' * 40},
                            {'id': 2, 'status': 'in_progress', 'run_attempt': 2, 'head_sha': 'b' * 40}]
                return []

            def download(self, route):
                self.downloads.append(route)
                return zipped('log.txt', b'clear')

        client = FakeGithub('example/project')
        report = {}
        with patch.object(audit, 'Github', return_value=client), patch.object(audit, 'scan_git'):
            audit.audit(audit.Scanner('marker'), 'example/project', '2', report)
        self.assertEqual(client.downloads, ['/actions/runs/1/attempts/1/logs',
                                           '/actions/runs/1/attempts/2/logs',
                                           '/actions/runs/2/attempts/1/logs'])
        self.assertEqual(report['excluded_current_run'], '2')

    def test_attachments_require_review(self):
        with self.assertRaises(audit.AuditError):
            audit.scan_texts(audit.Scanner('marker'),
                             [{'body': 'https://github.com/user-attachments/assets/example'}], 'pull')


if __name__ == '__main__':
    unittest.main()
