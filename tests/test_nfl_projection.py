import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "nfl-projection.py"
SPEC = importlib.util.spec_from_file_location("nfl_projection", MODULE_PATH)
PROJECTION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROJECTION)


class NflProjectionTests(unittest.TestCase):
    def test_week_two_projection_is_two_points_lower(self):
        stats = {
            "NE": {"pf_sum": 80, "pa_sum": 60, "wins": 3, "gp": 4},
            "SEA": {"pf_sum": 72, "pa_sum": 64, "wins": 2, "gp": 4},
        }

        regular_score = PROJECTION.project_score("NE", "SEA", stats)
        week_two_score = PROJECTION.project_week_two_score("NE", "SEA", stats)

        self.assertEqual(week_two_score, regular_score - 2)

    def test_week_two_projection_never_goes_below_zero(self):
        stats = {
            "NE": {"pf_sum": 8, "pa_sum": 8, "wins": 0, "gp": 4},
            "SEA": {"pf_sum": 8, "pa_sum": 8, "wins": 0, "gp": 4},
        }

        self.assertEqual(PROJECTION.project_week_two_score("NE", "SEA", stats), 0)


if __name__ == "__main__":
    unittest.main()