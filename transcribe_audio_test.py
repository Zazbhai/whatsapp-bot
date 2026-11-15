import sys
import types
import unittest
from unittest.mock import patch

from transcribe_audio import install_pyav_metadata_errors_compatibility


class PyAvCompatibilityTests(unittest.TestCase):
    def test_retries_without_unsupported_metadata_errors_keyword(self):
        calls = []

        def old_open(source, mode='r'):
            calls.append((source, mode))
            return 'container'

        fake_av = types.SimpleNamespace(open=old_open)
        with patch.dict(sys.modules, {'av': fake_av}):
            install_pyav_metadata_errors_compatibility()
            result = fake_av.open('audio.wav', metadata_errors='ignore')

        self.assertEqual(result, 'container')
        self.assertEqual(calls, [('audio.wav', 'r')])

    def test_preserves_unrelated_type_errors(self):
        def broken_open(*args, **kwargs):
            raise TypeError('invalid stream configuration')

        fake_av = types.SimpleNamespace(open=broken_open)
        with patch.dict(sys.modules, {'av': fake_av}):
            install_pyav_metadata_errors_compatibility()
            with self.assertRaisesRegex(TypeError, 'invalid stream configuration'):
                fake_av.open('audio.wav', metadata_errors='ignore')


if __name__ == '__main__':
    unittest.main()
