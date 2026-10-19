import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('cold_history', Path(__file__).with_name('cold_history.py'))
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)


class ColdHistoryTests(unittest.TestCase):
    def test_all_bytes_links_attributes_and_empty_files_survive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)/'source'
            root.mkdir()
            (root/'empty').touch()
            (root/'data').write_bytes(bytes(range(256))*100)
            os.link(root/'data', root/'hardlink')
            (root/'link').symlink_to('data')
            metadata = Path(directory)/'metadata.gz'
            history.capture(root, metadata)
            result = history.verify(root, root, metadata)
            self.assertTrue(result['verified'])
            self.assertEqual(result['files'], 3)
            self.assertEqual(result['unique_files'], 2)

    def test_a_changed_source_blocks_activation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)/'source'
            root.mkdir()
            (root/'data').write_text('full original')
            metadata = Path(directory)/'metadata.gz'
            history.capture(root, metadata)
            (root/'data').write_text('changed')
            with self.assertRaises(ValueError):
                history.verify(root, root, metadata)


if __name__ == '__main__':
    unittest.main()
