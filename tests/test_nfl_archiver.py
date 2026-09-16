import importlib.util
import tempfile
import unittest
from pathlib import Path

from bs4 import BeautifulSoup


MODULE_PATH = Path(__file__).parents[1] / "nfl-archiver.py"
SPEC = importlib.util.spec_from_file_location("nfl_archiver", MODULE_PATH)
ARCHIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ARCHIVER)


class NflArchiverTests(unittest.TestCase):
    def test_summary_handles_home_and_away_spreads(self):
        html = """
        <section>
          <article class="game-card" data-game="BAL-IND">
            <h2>Game 1: BAL @ IND</h2>
            <p class="line">Line: BAL -3.5 O/U 44.5</p>
            <table>
              <tr><td><b>Projected Score:</b></td><td>BAL 24 - IND 17</td></tr>
              <tr><td><b>Final Score:</b></td><td>BAL 20 - IND 23</td></tr>
            </table>
          </article>
          <article class="game-card" data-game="NE-SEA">
            <h2>Game 2: NE @ SEA</h2>
            <p class="line">Line: SEA -3 O/U 44.5</p>
            <table>
              <tr><td><b>Projected Score:</b></td><td>NE 17 - SEA 24</td></tr>
              <tr><td><b>Final Score:</b></td><td>NE 10 - SEA 24</td></tr>
            </table>
          </article>
        </section>
        """
        soup = BeautifulSoup(html, "html.parser")
        summary = ARCHIVER.summarize(soup)
        self.assertEqual(summary["games"], 2)
        self.assertEqual(summary["winner_win"], 1)
        self.assertEqual(summary["winner_loss"], 1)
        self.assertEqual(summary["ats_win"], 1)
        self.assertEqual(summary["ats_loss"], 1)

    def test_incomplete_final_score_is_rejected(self):
        html = """
        <article class="game-card" data-game="NE-SEA">
          <p class="line">Line: SEA -3</p>
          <table>
            <tr><td>Projected Score:</td><td>NE 17 - SEA 24</td></tr>
            <tr><td>Final Score:</td><td><!--FINAL-SCORE-NE-SEA--></td></tr>
          </table>
        </article>
        """
        soup = BeautifulSoup(html, "html.parser")
        with self.assertRaises(ValueError):
            ARCHIVER.summarize(soup)

    def test_annotations_are_ignored_when_tabulating_final_scores(self):
        html = """
        <article class="game-card" data-game="NE-SEA">
          <p class="line">Line: SEA -3 O/U 44.5</p>
          <table>
            <tr><td>Projected Score:</td><td>NE 17 - SEA 24</td></tr>
            <tr><td>Final Score:</td><td><span style="color: green">NE 10 - SEA 31 W&nbsp;(T)</span></td></tr>
          </table>
        </article>
        """
        summary = ARCHIVER.summarize(BeautifulSoup(html, "html.parser"))
        self.assertEqual(summary["games"], 1)
        self.assertEqual(summary["winner_win"], 1)
        self.assertEqual(summary["ats_win"], 1)

    def test_ats_tie_is_a_cover_for_projected_side(self):
        html = """
        <article class="game-card" data-game="NE-SEA">
          <p class="line">Line: SEA -3 O/U 44.5</p>
          <table>
            <tr><td>Projected Score:</td><td>NE 17 - SEA 24</td></tr>
            <tr><td>Final Score:</td><td>NE 10 - SEA 13</td></tr>
          </table>
        </article>
        """
        summary = ARCHIVER.summarize(BeautifulSoup(html, "html.parser"))
        self.assertEqual(summary["ats_win"], 1)
        self.assertEqual(summary["ats_push"], 0)

    def test_archive_row_is_idempotent_and_updates_totals(self):
        archive_html = """
        <table id="weekly-results">
          <tbody><tr id="season-total"><td>Season total</td><td>0-0-0</td><td>0.00%</td><td>0-0-0</td><td>0.00%</td></tr></tbody>
        </table>
        """
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "archive.htm"
            archive_path.write_text(archive_html, encoding="utf-8")
            original_path = ARCHIVER.ARCHIVE_FILE
            ARCHIVER.ARCHIVE_FILE = archive_path
            try:
                summary = {
                    "winner_win": 1, "winner_loss": 0, "winner_push": 0,
                    "ats_win": 0, "ats_loss": 1, "ats_push": 0,
                }
                ARCHIVER.update_archive(1, summary)
                ARCHIVER.update_archive(1, summary)
                result = archive_path.read_text(encoding="utf-8")
                self.assertEqual(result.count('data-week="1"'), 1)
                self.assertIn("1-0-0", result)
                self.assertIn("0-1-0", result)
            finally:
                ARCHIVER.ARCHIVE_FILE = original_path

    def test_main_archives_active_week_with_final_suffix(self):
        weekly_html = """
        <h1>Week 1 Picks</h1>
        <article class="game-card" data-game="NE-SEA">
          <p class="line">Line: SEA -3 O/U 44.5</p>
          <table>
            <tr><td><b>Projected Score:</b></td><td>NE 17 - SEA 24</td></tr>
            <tr><td><b>Final Score:</b></td><td><span>NE 10 - SEA 24 W&nbsp;(U)</span></td></tr>
          </table>
        </article>
        """
        archive_html = """
        <table id="weekly-results">
          <tbody><tr id="season-total"><td>Season total</td><td>0-0-0</td><td>0.00%</td><td>0-0-0</td><td>0.00%</td></tr></tbody>
        </table>
        """
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            active_path = root / "nfleTMP.htm"
            weekly_path = root / "nfle26-01.htm"
            archive_dir = root / "archives" / "2026"
            archive_path = archive_dir / "26_NFLEArch.htm"
            active_path.write_text(weekly_html, encoding="utf-8")
            weekly_path.write_text(weekly_html, encoding="utf-8")
            archive_dir.mkdir(parents=True)
            archive_path.write_text(archive_html, encoding="utf-8")

            original_values = (ARCHIVER.ACTIVE_FILE, ARCHIVER.ARCHIVE_DIR, ARCHIVER.ARCHIVE_FILE)
            ARCHIVER.ACTIVE_FILE = active_path
            ARCHIVER.ARCHIVE_DIR = archive_dir
            ARCHIVER.ARCHIVE_FILE = archive_path
            try:
                ARCHIVER.main()
                final_path = archive_dir / "nfle26-01F.htm"
                self.assertTrue(final_path.exists())
                self.assertIn('data-week="1"', archive_path.read_text(encoding="utf-8"))
            finally:
                ARCHIVER.ACTIVE_FILE, ARCHIVER.ARCHIVE_DIR, ARCHIVER.ARCHIVE_FILE = original_values


if __name__ == "__main__":
    unittest.main()
