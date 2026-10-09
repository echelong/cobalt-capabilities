import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).parents[1] / 'bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTests(unittest.TestCase):
    def test_disabled_zero_io(self):
        with patch.object(bridge, 'load_config', side_effect=AssertionError('IO')):
            self.assertEqual(bridge.dispatch({'capability':'memory'})['status'], 'disabled')
            self.assertEqual(bridge.dispatch({'capability':'browser'})['status'], 'disabled')

    def test_config_must_be_private_regular_owned_file(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / 'config.json'
            p.write_text(json.dumps({'memory_enabled':False}))
            p.chmod(0o644)
            with self.assertRaises(ValueError): bridge.load_config(str(p))
            p.chmod(0o600)
            self.assertFalse(bridge.load_config(str(p))['memory_enabled'])
            link = Path(directory) / 'link.json'; link.symlink_to(p)
            with self.assertRaises(OSError): bridge.load_config(str(link))
            fifo = Path(directory) / 'fifo'; os.mkfifo(fifo, 0o600)
            with self.assertRaises(ValueError): bridge.load_config(str(fifo))

    def test_second_switch_disabled_starts_no_workers(self):
        with patch.object(bridge, 'load_config', return_value={'browser_enabled':False}), patch.object(bridge.subprocess, 'run', side_effect=AssertionError('worker')):
            self.assertEqual(bridge.dispatch({'capability':'browser','enabled':True})['status'],'disabled')

    def test_path_traversal_refused_before_creation(self):
        with patch.object(bridge, 'load_config', return_value={'browser_enabled':True,'lock_directory':'/mnt/mem2/../../tmp/invalid-lock'}):
            with self.assertRaises(ValueError): bridge.dispatch({'capability':'browser','enabled':True})

    def test_lock_levels_are_tightened_not_trusted(self):
        with tempfile.TemporaryDirectory() as base:
            with patch.object(bridge, 'LOCK_ROOT', base):
                root = Path(base) / f'cobalt-capabilities-{os.getuid()}'
                root.mkdir(mode=0o755)
                os.chmod(root, 0o755)
                config = {'browser_enabled': True, 'obscura_endpoint': 'ws://127.0.0.1:9222'}
                worker = subprocess.CompletedProcess([], 0, '{"status": "ready"}', '')
                with patch.object(bridge, 'load_config', return_value=config), patch.object(bridge.subprocess, 'run', return_value=worker):
                    self.assertEqual(bridge.dispatch({'capability': 'browser', 'enabled': True})['status'], 'ready')
                self.assertEqual(root.stat().st_mode & 0o777, 0o700)
                self.assertEqual((root / 'locks').stat().st_mode & 0o777, 0o700)


    def test_step_lines_are_fixed_shape_and_never_fatal(self):
        import io
        with patch.object(bridge.sys, 'stderr', io.StringIO()) as stream:
            bridge.report_step('recall')
            self.assertEqual(stream.getvalue(), '{"cobalt_step": "recall"}\n')
        class Closed:
            def write(self, _): raise OSError('closed')
            def flush(self): raise OSError('closed')
        with patch.object(bridge.sys, 'stderr', Closed()):
            bridge.report_step('recall')

    def test_memory_step_is_reported_from_the_real_request_not_from_dispatch(self):
        with tempfile.TemporaryDirectory() as base, patch.object(bridge, 'LOCK_ROOT', base):
            config = {'memory_enabled': True, 'hindsight_endpoint': 'http://127.0.0.1:1', 'memory_timeout_ms': 200, 'memory_repositories': [base]}
            with patch.object(bridge, 'load_config', return_value=config), patch.object(bridge, 'report_step') as reported:
                # Not a repository: refused before any service request, so no step.
                refused = bridge.dispatch({'capability': 'memory', 'enabled': True, 'operation': 'status', 'repo': base})
                self.assertEqual(refused['status'], 'error'); reported.assert_not_called()
                subprocess.run(['git', 'init', '--quiet', base], check=True)
                down = bridge.dispatch({'capability': 'memory', 'enabled': True, 'operation': 'status', 'repo': base})
                self.assertEqual(down['status'], 'unavailable'); reported.assert_called_once_with('status')
                reported.reset_mock()
                bridge.dispatch({'capability': 'memory', 'enabled': True, 'operation': 'not-an-operation', 'repo': base})
                reported.assert_not_called()

    def test_browser_worker_inherits_stderr_and_keeps_stdout_for_the_result(self):
        with tempfile.TemporaryDirectory() as base, patch.object(bridge, 'LOCK_ROOT', base):
            worker = subprocess.CompletedProcess([], 0, '{"status": "observed"}', None)
            with patch.object(bridge, 'load_config', return_value={'browser_enabled': True}), patch.object(bridge.subprocess, 'run', return_value=worker) as run:
                self.assertEqual(bridge.dispatch({'capability': 'browser', 'enabled': True})['status'], 'observed')
            options = run.call_args.kwargs
            self.assertIs(options['stdout'], subprocess.PIPE); self.assertIsNone(options['stderr'])
            self.assertNotIn('capture_output', options)
            self.assertEqual(set(options['env']) - {'PATH', 'LANG', 'LC_ALL', 'TMPDIR'}, set())


    def test_an_unusable_worker_report_is_a_failure_with_possible_effects(self):
        with tempfile.TemporaryDirectory() as base, patch.object(bridge, 'LOCK_ROOT', base):
            for stdout in ('', 'not json', '[]', '"observed"', '{"status": "observed"} trailing'):
                worker = subprocess.CompletedProcess([], 0, stdout, None)
                with patch.object(bridge, 'load_config', return_value={'browser_enabled': True}), patch.object(bridge.subprocess, 'run', return_value=worker):
                    result = bridge.dispatch({'capability': 'browser', 'enabled': True})
                self.assertEqual(result, {'capability': 'browser', 'status': 'error', 'error': 'worker_failed', 'executed': False, 'effects_possible': True}, stdout)

    def test_lock_location_is_fixed_per_user_and_falls_back_under_the_same_checks(self):
        self.assertIsNone(bridge.LOCK_ROOT)
        self.assertEqual(bridge.lock_roots(), (f'/run/user/{os.getuid()}', '/tmp'))
        worker = subprocess.CompletedProcess([], 0, '{"status": "ready"}', None)
        with tempfile.TemporaryDirectory() as base:
            absent = str(Path(base) / 'no-runtime-directory')
            with patch.object(bridge, 'lock_roots', return_value=(absent, base)), patch.object(bridge, 'load_config', return_value={'browser_enabled': True}), patch.object(bridge.subprocess, 'run', return_value=worker):
                self.assertEqual(bridge.dispatch({'capability': 'browser', 'enabled': True})['status'], 'ready')
            root = Path(base) / f'cobalt-capabilities-{os.getuid()}'
            self.assertEqual(root.stat().st_mode & 0o777, 0o700)
            self.assertTrue(any((root / 'locks').iterdir()))
            # No usable location is its own diagnosable code, and starts no worker.
            with patch.object(bridge, 'lock_roots', return_value=(absent,)), patch.object(bridge, 'load_config', return_value={'browser_enabled': True}), patch.object(bridge.subprocess, 'run', side_effect=AssertionError('worker')):
                with self.assertRaises(ValueError) as raised: bridge.dispatch({'capability': 'browser', 'enabled': True})
            self.assertEqual(str(raised.exception), 'lock_storage_unavailable')
            # A location someone else prepared as a link is refused, not followed.
            elsewhere = Path(base) / 'elsewhere'; elsewhere.mkdir()
            planted = Path(base) / 'shared'; planted.mkdir()
            (planted / f'cobalt-capabilities-{os.getuid()}').symlink_to(elsewhere)
            with patch.object(bridge, 'lock_roots', return_value=(str(planted),)), patch.object(bridge, 'load_config', return_value={'browser_enabled': True}), patch.object(bridge.subprocess, 'run', side_effect=AssertionError('worker')):
                with self.assertRaises(ValueError): bridge.dispatch({'capability': 'browser', 'enabled': True})
            self.assertEqual(list(elsewhere.iterdir()), [])

    def test_the_adapter_is_loaded_from_beside_the_bridge_in_an_isolated_interpreter(self):
        self.assertEqual(Path(bridge.load_adapter().__file__), Path(bridge.__file__).with_name('hindsight.py'))
        with tempfile.TemporaryDirectory() as directory:
            # A same-named module on the search path or in the working directory is never the one loaded.
            (Path(directory) / 'hindsight.py').write_text('raise SystemExit("shadowed adapter was imported")\n')
            ran = subprocess.run(['python3', '-I', '-B', bridge.__file__], input=json.dumps({'capability': 'memory', 'enabled': False}),
                                 capture_output=True, text=True, cwd=directory, env={'PATH': os.environ['PATH'], 'PYTHONPATH': directory}, check=False)
        self.assertEqual(ran.returncode, 0, ran.stderr)
        self.assertEqual(json.loads(ran.stdout)['status'], 'disabled')


    def test_the_refusal_reason_lists_agree(self):
        # Three places name a refusal's rule: the memory adapter, the browser
        # worker and the host's receipt filter. A name missing from the filter
        # would be dropped from receipts without a word; one only in the filter
        # is a name nothing can send. The README table lists the same names.
        import re
        root = Path(__file__).parents[2]
        adapter = importlib.util.spec_from_file_location('hindsight', root / 'capabilities' / 'hindsight.py')
        hindsight = importlib.util.module_from_spec(adapter)
        adapter.loader.exec_module(hindsight)
        memory = set(hindsight._REFUSAL_REASONS.values()) | {'not_found'}
        browser = set(re.findall(r"refuse\('([a-z_]+)'", (root / 'capabilities' / 'browser.mjs').read_text()))
        listed = re.search(r'^const REASON = /\^\(([a-z_|]+)\)\$/$', (root / 'hooks' / 'state.ts').read_text(), re.M)
        self.assertIsNotNone(listed)
        receipts = listed.group(1).split('|')
        self.assertEqual(len(receipts), len(set(receipts)))
        self.assertGreater(len(browser), 10)
        self.assertEqual(set(receipts), memory | browser)
        readme = (root / 'README.md').read_text()
        for name in memory | browser:
            self.assertIn(f'`{name}`', readme)


if __name__ == '__main__': unittest.main()
