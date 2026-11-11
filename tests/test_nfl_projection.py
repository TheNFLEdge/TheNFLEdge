import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).parents[1] / "nfl-projection.py"
SPEC = importlib.util.spec_from_file_location("nfl_projection", MODULE_PATH)
PROJECTION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROJECTION)


class NflProjectionTests(unittest.TestCase):
    def setUp(self):
        self.multiplier_patch = patch.dict(PROJECTION.P_MULTIPLIERS, {
            "1.0": 2.4, "0.75": 2.2, "0.5": 2.0, "0.25": 1.66, "0.0": 1.5,
        })
        self.margin_patch = patch.object(PROJECTION, "MARGIN_ADJUSTMENT", 2.0)
        self.multiplier_patch.start()
        self.margin_patch.start()
        self.addCleanup(self.multiplier_patch.stop)
        self.addCleanup(self.margin_patch.stop)

    def test_projection_adds_points_per_quarter_before_multiplier(self):
        stats = {
            "NE": {"pf_sum": 80, "pa_sum": 60, "wins": 4, "gp": 4},
            "SEA": {"pf_sum": 72, "pa_sum": 64, "wins": 2, "gp": 4},
        }

        self.assertEqual(PROJECTION.project_score("NE", "SEA", stats), 24)

    def test_projection_never_goes_below_zero(self):
        stats = {
            "NE": {"pf_sum": 0, "pa_sum": 0, "wins": 0, "gp": 4},
            "SEA": {"pf_sum": 0, "pa_sum": 0, "wins": 0, "gp": 4},
        }

        self.assertEqual(PROJECTION.project_score("NE", "SEA", stats), 0)

    def test_tie_goes_to_higher_unrounded_projection(self):
        stats = {
            "NE": {"pf_sum": 33, "pa_sum": 32, "wins": 2, "gp": 4},
            "SEA": {"pf_sum": 32, "pa_sum": 32, "wins": 2, "gp": 4},
        }

        self.assertEqual(PROJECTION.project_matchup("NE", "SEA", stats), (9, 8))

    def test_exact_tie_goes_to_home_team(self):
        stats = {
            "NE": {"pf_sum": 32, "pa_sum": 32, "wins": 2, "gp": 4},
            "SEA": {"pf_sum": 32, "pa_sum": 32, "wins": 2, "gp": 4},
        }

        self.assertEqual(PROJECTION.project_matchup("NE", "SEA", stats), (8, 9))

    def test_impossible_scores_are_adjusted(self):
        fix = PROJECTION.fix_impossible_score
        self.assertEqual([fix(s) for s in (0, 1, 2, 3, 4, 5, 6, 7)], [0, 3, 3, 3, 6, 6, 6, 7])

    def test_matchup_never_ties_or_gives_impossible_scores(self):
        for pf in range(0, 40, 3):
            for pa in range(0, 40, 3):
                stats = {
                    "A": {"pf_sum": pf, "pa_sum": pa, "wins": 2, "gp": 4},
                    "B": {"pf_sum": pa, "pa_sum": pf, "wins": 2, "gp": 4},
                }
                with self.subTest(pf=pf, pa=pa):
                    scores = PROJECTION.project_matchup("A", "B", stats)
                    self.assertNotEqual(*scores)
                    self.assertTrue(all(score not in (1, 2, 4, 5) for score in scores))

    def test_weekly_template_generates_navigable_viewport_and_canonical_issue(self):
        stats = {
            "NE": {"pf_sum": 33, "pa_sum": 32, "wins": 2, "gp": 4},
            "SEA": {"pf_sum": 32, "pa_sum": 32, "wins": 2, "gp": 4},
        }
        matchups = [{"away": "NE", "home": "SEA", "line": "NE -1", "ou": 42}]
        template = PROJECTION.TEMPLATE_FILE.read_text(encoding="utf-8")
        self.assertIn("<!-- GAME-CARDS -->\n            <!--ADVERTISEMENT-->", template)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            handoff = root / "handoff.json"
            handoff.write_text(json.dumps({
                "target_week": 3, "matchups": matchups, "team_stats": stats,
            }), encoding="utf-8")
            with patch.object(PROJECTION, "ROOT", root), \
                 patch.object(PROJECTION, "HANDOFF_FILE", handoff), \
                 patch.object(PROJECTION, "load_generation_state") as validate, \
                 patch.object(PROJECTION, "write_manifest") as manifest:
                PROJECTION.main()

            canonical = root / "nfle26-03.htm"
            html = canonical.read_text(encoding="utf-8")
            self.assertEqual(html, (root / "nfleTMP.htm").read_text(encoding="utf-8"))
            self.assertIn("<h1>Week 3 Picks</h1>", html)
            self.assertIn(PROJECTION.render_week(matchups, stats), html)
            self.assertIn("<!--FINAL-SCORE-NE-SEA-->", html)
            self.assertIn('href="https://thenfledge.github.io/TheNFLEdge/"', html)
            self.assertIn('href="https://thenfledge.github.io/TheNFLEdge/archives/index.html"', html)
            self.assertIn('src="https://thenfledge.github.io/TheNFLEdge/images/NFLBAN26.jpg"', html)
            self.assertIn('src="https://thenfledge.github.io/TheNFLEdge/images/Hat3.png"', html)
            self.assertIn('<a class="site-banner-link" href="https://thenfledge.github.io/TheNFLEdge/"', html)
            self.assertNotIn("<!-- GAME-CARDS -->", html)
            validate.assert_called_once_with(3)
            manifest.assert_called_once_with(3, canonical)


if __name__ == "__main__":
    unittest.main()