import subprocess
import unittest
from unittest.mock import patch
from game.preflight import check


class PreflightTests(unittest.TestCase):
    @patch('game.preflight.shutil.which', return_value=None)
    def test_missing_runtime(self, _):
        report = check('missing', '', None)
        self.assertFalse(report['prerequisites_ok'])
        self.assertFalse(report['connection_verified'])

    @patch('game.preflight.subprocess.run', return_value=subprocess.CompletedProcess([], 0, 'Version: Factorio 2', ''))
    @patch('game.preflight.shutil.which', return_value='/game/factorio')
    def test_prerequisites_do_not_prove_connection(self, *_):
        report = check('factorio', 'localhost:34197', ':0')
        self.assertTrue(report['prerequisites_ok'])
        self.assertFalse(report['connection_verified'])

    @patch('game.preflight.subprocess.run', side_effect=subprocess.TimeoutExpired('factorio', 10))
    @patch('game.preflight.shutil.which', return_value='/game/factorio')
    def test_hung_binary_fails(self, *_):
        self.assertFalse(check('factorio', 'host', ':0')['prerequisites_ok'])
