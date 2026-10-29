import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "nfl-projection.py"
SPEC = importlib.util.spec_from_file_location("nfl_projection", MODULE_PATH)
PROJECTION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROJECTION)


class NflProjectionTests(unittest.TestCase):
    def test_projection_adds_ppqf_and_ppqa_before_multiplier(self):
        stats = {
            "NE": {"pf_sum": 80, "pa_sum": 60, "wins": 4, "gp": 4},
            "SEA": {"pf_sum": 72, "pa_sum": 64, "wins": 2, "gp": 4},
        }

        # (80/16 + 64/16) = 9.0; 9.0 * 2.4 = 21.6; ceil(21.6 + 2) = 24
        self.assertEqual(PROJECTION.project_score("NE", "SEA", stats), 24)

    def test_projection_never_goes_below_zero(self):
        stats = {
            "NE": {"pf_sum": 0, "pa_sum": 0, "wins": 0, "gp": 4},
            "SEA": {"pf_sum": 0, "pa_sum": 0, "wins": 0, "gp": 4},
        }

        self.assertEqual(PROJECTION.project_score("NE", "SEA", stats), 0)

    def test_tie_goes_to_higher_unrounded_projection(self):
        # Both 0.5 bucket: NE raw 9.4 -> 9, SEA raw 9.2 -> 9; NE has the higher raw.
        stats = {
            "NE": {"pf_sum": 32, "pa_sum": 32, "wins": 2, "gp": 4},
            "SEA": {"pf_sum": 32, "pa_sum": 32, "wins": 2, "gp": 4},
        }
        stats["NE"]["pf_sum"] = 33
        away, home = PROJECTION.project_matchup("NE", "SEA", stats)
        self.assertNotEqual(away, home)
        self.assertGreater(away, home)

    def test_impossible_scores_are_adjusted(self):
        fix = PROJECTION.fix_impossible_score
        self.assertEqual([fix(s) for s in (1, 2, 3, 4, 5, 6, 0, 7)], [3, 3, 3, 6, 6, 6, 0, 7])

    def test_matchup_never_ties_or_gives_impossible_scores(self):
        for pf in range(0, 40, 3):
            for pa in range(0, 40, 3):
                stats = {
                    "A": {"pf_sum": pf, "pa_sum": pa, "wins": 2, "gp": 4},
                    "B": {"pf_sum": pa, "pa_sum": pf, "wins": 2, "gp": 4},
                }
                scores = PROJECTION.project_matchup("A", "B", stats)
                self.assertNotEqual(*scores)
                self.assertTrue(all(s not in (1, 2, 4, 5) for s in scores))


if __name__ == "__main__":
    unittest.main()