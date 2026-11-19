import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urljoin
from unittest.mock import patch

from bs4 import BeautifulSoup


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
        stats = {
            "NE": {"pf_sum": 33, "pa_sum": 32, "wins": 2, "gp": 4},
            "SEA": {"pf_sum": 32, "pa_sum": 32, "wins": 2, "gp": 4},
        }

        away, home = PROJECTION.project_matchup("NE", "SEA", stats)
        self.assertEqual((away, home), (9, 8))
        self.assertGreater(away, home)

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

    def test_feesh_banner_resolves_in_root_and_archived_issues(self):
        site = "https://thenfledge.github.io/TheNFLEdge/"
        pages = (
            (PROJECTION.render_feeshvertisement(), "images/gfeesh-promo-ad.jpg"),
            ((PROJECTION.ROOT / "archives" / "2026" / "nfle26-09F.htm").read_text(encoding="utf-8"),
             "images/gfish-promo-ad.jpg"),
            ((PROJECTION.ROOT / "archives" / "2026" / "nfle26-10F.htm").read_text(encoding="utf-8"),
             "images/gfish-promo-ad.jpg"),
        )
        for html, asset in pages:
            expected = urljoin(site, asset)
            image = BeautifulSoup(html, "html.parser").find("img", alt="Greggy Feesh Promo Banner")
            self.assertIsNotNone(image)
            for page in ("nfleTMP.htm", "archives/2026/nfle26-10F.htm"):
                with self.subTest(page=page):
                    self.assertEqual(urljoin(urljoin(site, page), image["src"]), expected)

    def test_weekly_ad_placement_and_thanksgiving_selection(self):
        matchups = [{"away": f"A{i}", "home": f"B{i}", "line": "A -1"} for i in range(16)]
        site = "https://thenfledge.github.io/TheNFLEdge/"
        for week in (10, 11, 12, 13):
            with self.subTest(week=week):
                html = PROJECTION.render_week(matchups, {}, week)
                soup = BeautifulSoup(html, "html.parser")
                sections = soup.select("section.ad-box")
                self.assertEqual(len(sections), 4)
                nba, chw, liberty, feesh = sections
                self.assertEqual(nba["data-ad-asset"], "nba-edge")
                self.assertEqual(nba.find("a")["href"], "https://thenfledge.github.io/TheNBAEdge/index.html")
                self.assertIn("PRO Properties Group", chw.get_text())
                self.assertIn("Liberty Mutual", liberty.get_text())
                self.assertLess(html.index('data-game="A3-B3"'), html.index("<!--NBAEDGEADVERTISEMENT-->"))
                self.assertLess(html.index("<!--NBAEDGEADVERTISEMENT-->"), html.index('data-game="A4-B4"'))
                self.assertEqual(html.count("<!--ADVERTISEMENT-->"), 1)
                self.assertEqual(html.count("<!--FEESHVERTISEMENT-->"), 1)
                image = feesh.find("img")
                if week in (11, 12):
                    self.assertEqual(image["src"], urljoin(site, "images/gfeesh-thanksgiving-ad.jpg"))
                    self.assertIn(PROJECTION.PUMPKIN_PIE_RELEASE_URL, html)
                    self.assertIn(PROJECTION.THANKSGIVING_RELEASE_URL, html)
                else:
                    self.assertEqual(image["src"], urljoin(site, "images/gfeesh-promo-ad.jpg"))
                    self.assertIn("Catch the latest", feesh.get_text())
                    self.assertIn("FRESH FEESH", feesh.get_text())
                    self.assertIn("color:#7fff00;", feesh.find("strong")["style"])
                    self.assertIn("color:#c15cff;", feesh.find_all("strong")[-1]["style"])
                    self.assertNotIn(PROJECTION.THANKSGIVING_RELEASE_URL, html)
                for page in ("nfleTMP.htm", "archives/2026/nfle26-10F.htm"):
                    self.assertEqual(urljoin(urljoin(site, page), nba.find("img")["src"]),
                                     urljoin(site, "images/nbaedge-banner.jpg"))
                    self.assertEqual(urljoin(urljoin(site, page), image["src"]), image["src"])
        for asset in ("nbaedge-banner.jpg", "gfeesh-thanksgiving-ad.jpg", "gfeesh-promo-ad.jpg"):
            self.assertTrue((PROJECTION.ROOT / "images" / asset).is_file())

    def test_banner_ads_have_readable_overlay_and_caption_structure(self):
        nba = BeautifulSoup(PROJECTION.render_nbaedge_advertisement(), "html.parser")
        nba_link = nba.find("a")
        self.assertIn("position:relative", nba_link["style"])
        self.assertIn("object-fit:cover", nba_link.find("img")["style"])
        self.assertIn("Explore The NBA Edge", nba_link.get_text())

        feesh = BeautifulSoup(PROJECTION.render_thanksgiving_feeshvertisement(), "html.parser")
        image = feesh.find("img")
        artwork = image.parent
        self.assertIn("object-fit:cover", image["style"])
        self.assertEqual(
            {link["href"] for link in artwork.find_all("a")},
            {PROJECTION.PUMPKIN_PIE_RELEASE_URL, PROJECTION.THANKSGIVING_RELEASE_URL},
        )
        self.assertIn("position:absolute", artwork.find("a").parent["style"])
        self.assertIn("What's better than Thanksgiving", artwork.find_next_sibling("div").get_text())

        regular_feesh = BeautifulSoup(PROJECTION.render_feeshvertisement(), "html.parser")
        regular_image = regular_feesh.find("img")
        overlay = regular_image.find_next("div")
        self.assertIn("background:rgba(0,0,0,0.78)", overlay["style"])
        self.assertIn("left:0", overlay["style"])
        self.assertIn("right:0", overlay["style"])
        self.assertIn("Catch the latest", overlay.get_text(" ", strip=True))

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