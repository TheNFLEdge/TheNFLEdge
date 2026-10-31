import json
import hashlib
import math
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HANDOFF_FILE = ROOT / "nfl_data_handoff.json"
TEMPLATE_FILE = ROOT / "nfle26-template.htm"
STATE_FILE = ROOT / "nfl_rotation_state.json"

P_MULTIPLIERS = {
    "1.0": float(os.getenv("PG_PI0", "2.4")),
    "0.75": float(os.getenv("PG_PI7", "2.2")),
    "0.5": float(os.getenv("PG_PPI5", "2.0")),
    "0.25": float(os.getenv("PG_PI2", "1.66")),
    "0.0": float(os.getenv("PG_PI_X", "1.5")),
}
MARGIN_ADJUSTMENT = float(os.getenv("PG_MD", "2.0"))


def confidence_bucket(wins, games):
    percentage = wins / games if games else 0
    if percentage >= 0.8:
        return "1.0"
    if percentage >= 0.6:
        return "0.75"
    if percentage >= 0.4:
        return "0.5"
    if percentage >= 0.2:
        return "0.25"
    return "0.0"


def project_raw_score(team, opponent, stats):
    team_stats = stats[team]
    opponent_stats = stats[opponent]
    # Points per quarter over the trailing window (4 games = 16 quarters).
    team_ppqf = team_stats["pf_sum"] / (team_stats["gp"] * 4)
    opponent_ppqa = opponent_stats["pa_sum"] / (opponent_stats["gp"] * 4)
    base_score = team_ppqf + opponent_ppqa
    bucket = confidence_bucket(team_stats["wins"], team_stats["gp"])
    score = base_score * P_MULTIPLIERS[bucket]
    if float(bucket) >= 0.75:
        return score + MARGIN_ADJUSTMENT, math.ceil
    if float(bucket) <= 0.25:
        return score - MARGIN_ADJUSTMENT, math.floor
    return score, round


def project_score(team, opponent, stats):
    raw, rounder = project_raw_score(team, opponent, stats)
    return max(0, rounder(raw))


def fix_impossible_score(score):
    if score in (1, 2):
        return 3
    if score in (4, 5):
        return 6
    return score


def project_matchup(away, home, stats):
    away_raw, away_round = project_raw_score(away, home, stats)
    home_raw, home_round = project_raw_score(home, away, stats)
    away_score = fix_impossible_score(max(0, away_round(away_raw)))
    home_score = fix_impossible_score(max(0, home_round(home_raw)))
    if away_score == home_score:
        # Higher unrounded projection gets the extra point; home team wins an exact raw tie.
        if away_raw > home_raw:
            away_score = fix_impossible_score(away_score + 1)
        else:
            home_score = fix_impossible_score(home_score + 1)
    return away_score, home_score


def render_card(index, matchup, stats):
    away = matchup["away"]
    home = matchup["home"]
    line = matchup["line"]
    total = f' O/U {matchup["ou"]}' if matchup.get("ou") is not None else ""
    if away not in stats or home not in stats or not stats[away]["gp"] or not stats[home]["gp"]:
        content = f'<p class="pending">Projection pending for {away} @ {home}; season data is not available yet.</p>'
    else:
        away_score, home_score = project_matchup(away, home, stats)
        content = (
            f'<table><tr><td><b>Projected Score:</b></td>'
            f'<td>{away} {away_score} - {home} {home_score}</td></tr>'
            f'<tr><td><b>Final Score:</b></td>'
            f'<td><!--FINAL-SCORE-{away}-{home}--></td></tr></table>'
        )
    return (
        f'<article class="game-card" data-game="{away}-{home}">'
        f'<h2>Game {index}: {away} @ {home}</h2>'
        f'<p class="line">Line: {line}{total}</p>{content}</article>'
    )


def render_advertisement():
    return """<!--ADVERTISEMENT-->
<section class="ad-box" aria-label="Advertisement">
    <h2>Save on insurance with Liberty Mutual</h2>
    <p>Stop worrying and start saving with Liberty Mutual. <a href="https://www.libertymutual.com/gregpanagiotatos-fl-445190?selectedOpt=auto_home" target="_blank" rel="noopener noreferrer"><strong>Click here</strong></a> for customized coverage that fits your budget.</p>
    <p class="ad-image"><a href="https://www.libertymutual.com/gregpanagiotatos-fl-445190?selectedOpt=auto_home" target="_blank" rel="noopener noreferrer"><img src="https://blogger.googleusercontent.com/img/a/AVvXsEhJW-A8S78eGMtpVFkeRci_bw-7VWlCoeciRZcJUMWjB5DtjShq5VkTHQlfviT-NDUGojGsGqKbT8zLU4t3oS4JQoMVNmz-APnV0M1wqcPtuF2iaM8FstJqH6miChLR22EFbW1-SqAQ4n79OK1KSedBJ4Xi4AKF46QX8cfArNfGwKf5aMUxoKuOYG68SYc" alt="Liberty Mutual" loading="lazy"></a></p>
    <p>Call a licensed insurance agent at <strong>800-266-0644</strong> and mention client number <strong>445190</strong>.</p>
</section>"""


def render_feeshvertisement():
    return """<!--FEESHVERTISEMENT-->
<section class="ad-box" aria-label="Advertisement">
    <a href="https://open.spotify.com/artist/6fa6DV6wh6WscR3R7fWAyI" target="_blank" rel="noopener noreferrer" style="text-decoration:none; color:inherit;">
        <div style="position:relative; display:inline-block; width:100%;">
            <img src="images/gfish-promo-ad.jpg" alt="Greggy Feesh Promo Banner" loading="lazy" style="width:100%; height:auto; display:block;">
            <div style="position:absolute; left:0; right:0; bottom:0; background:linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.88) 55%); padding:34px 14px 10px; color:#fff; font-size:clamp(.85rem, 2.6vw, 1.1rem); font-weight:bold; line-height:1.3; text-align:center; font-family:Arial, sans-serif; text-shadow:0 1px 3px #000;">
                Tired of the same old lame old songs? Check out the latest <strong style="color:#ffd700;">FRESH FEESH</strong> music from your new favorite artist <strong style="color:#c15cff;">Greggy Feesh and the Phlops</strong>.
            </div>
        </div>
    </a>
</section>"""

CHW_URL = "https://propropertylist.com/chw/"
CHW_HERO_URL = "https://propropertylist.com/chw/images/chw_hero.jpg"
CHW_LOGO_URL = "https://propropertylist.com/chw/images/PROProps.jpg"


def render_chw_advertisement():
    return f"""<!--CHWVERTISEMENT-->
<section class="ad-box" aria-label="Advertisement" style="padding:0; background:#0F2C59; border:1px solid #0F2C59; overflow:hidden;">
    <a href="{CHW_URL}" target="_blank" rel="noopener noreferrer" style="display:block; text-decoration:none; color:#fff;">
        <div style="background:linear-gradient(90deg, rgba(15,44,89,.97) 0%, rgba(15,44,89,.90) 55%, rgba(15,44,89,.55) 100%), url('{CHW_HERO_URL}') center/cover no-repeat, #0F2C59; padding:26px 28px; text-align:left; font-family:Arial, sans-serif;">
            <div style="display:flex; align-items:center; gap:20px; flex-wrap:wrap; margin-bottom:16px;">
                <div style="background:#fff; padding:6px 12px; border-radius:8px; flex:0 0 auto;">
                    <img src="{CHW_LOGO_URL}" alt="PRO Properties Group" loading="lazy" style="display:block; width:auto; height:56px; max-width:100%; margin:0;">
                </div>
                <div style="flex:1 1 220px;">
                    <div style="font-size:clamp(24px, 5vw, 34px); font-weight:800; line-height:1.1; color:#fff;">Own the Property.</div>
                    <div style="font-size:clamp(20px, 4vw, 28px); font-weight:700; font-style:italic; line-height:1.2; color:#8EC5FF;">Not the Headaches.</div>
                </div>
            </div>
            <div style="font-size:16px; line-height:1.45; color:#fff; margin-bottom:18px;">Property management done right, done simply &mdash; leave the hassles to the pros at <strong style="color:#8EC5FF;">PRO Properties Group</strong>.</div>
            <div style="display:block; background:#FF6B35; color:#fff; font-weight:800; font-size:17px; padding:14px 22px; border-radius:8px; text-align:center;">Get My Free Property Review &rarr;</div>
        </div>
    </a>
</section>"""


def render_week(matchups, stats):
    sections = []
    for group_start in range(0, 16, 4):
        group = matchups[group_start:group_start + 4]
        sections.extend(
            render_card(group_start + index, matchup, stats)
            for index, matchup in enumerate(group, 1)
        )
        if group_start + 4 >= 16:
            sections.append(render_feeshvertisement())
        elif group_start == 4:
            sections.append(render_chw_advertisement())
        else:
            sections.append(render_advertisement())
    return "\n".join(sections)


def main():
    if not HANDOFF_FILE.exists() or not TEMPLATE_FILE.exists():
        raise FileNotFoundError("nfl_data_handoff.json and nfle26-template.htm are required")
    data = json.loads(HANDOFF_FILE.read_text(encoding="utf-8"))
    template = TEMPLATE_FILE.read_text(encoding="utf-8")
    week = int(data["target_week"])
    load_generation_state(week)
    weekly_content = render_week(data["matchups"], data["team_stats"])
    final_html = template.replace("{{WEEK}}", str(week)).replace("<!-- GAME-CARDS -->\n            <!--ADVERTISEMENT-->", weekly_content)
    canonical_path = ROOT / f"nfle26-{week:02d}.htm"
    viewport_path = ROOT / "nfleTMP.htm"
    write_atomic(canonical_path, final_html)
    write_atomic(viewport_path, final_html)
    write_manifest(week, canonical_path)
    print(f"NFL Week {week} projections written to nfleTMP.htm and nfle26-{week:02d}.htm")


def load_generation_state(target_week):
    if not STATE_FILE.exists():
        raise RuntimeError("Rotation state validation failed: nfl_rotation_state.json is missing. Run npm run recover:rotation -- --week=N after verifying the canonical issue.")
    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Rotation state validation failed: invalid JSON ({error}).") from error
    active_week = state.get("active_week")
    if state.get("schema_version") != 1 or state.get("season") != int(os.getenv("NFL_SEASON", "2026")):
        raise RuntimeError("Rotation state validation failed: unsupported schema or season mismatch.")
    if not isinstance(active_week, int) or not 1 <= active_week <= 18:
        raise RuntimeError("Rotation state validation failed: active_week must be an integer from 1 through 18.")
    if target_week != active_week + 1:
        raise RuntimeError(f"Sequential generation refused target Week {target_week} for active Week {active_week}.")
    active_issue_name = state.get("active_issue")
    if active_issue_name != f"nfle26-{active_week:02d}.htm" or not re.fullmatch(r"nfle26-[0-9]{2}\.htm", active_issue_name or ""):
        raise RuntimeError("Rotation state validation failed: active_issue is unsafe or inconsistent with active_week.")
    active_issue = ROOT / active_issue_name
    archived_issue = ROOT / "archives" / "2026" / f"nfle26-{active_week:02d}F.htm"
    expected_hash = state.get("active_issue_sha256")
    source = active_issue if active_issue.exists() else archived_issue
    if not source.exists() or canonical_sha256(source) != expected_hash:
        raise RuntimeError("Rotation state validation failed: the recorded active issue checksum cannot be verified.")
    return state


def write_manifest(week, canonical_path):
    manifest = {
        "schema_version": 1,
        "season": int(os.getenv("NFL_SEASON", "2026")),
        "active_week": week,
        "active_issue": f"nfle26-{week:02d}.htm",
        "active_issue_sha256": canonical_sha256(canonical_path),
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "generated_by": "rotation",
        "viewport": "nfleTMP.htm"
    }
    write_json_atomic(STATE_FILE, manifest)


def canonical_sha256(path):
    content = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def write_json_atomic(path, value):
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        temporary_path = Path(handle.name)
        json.dump(value, handle, indent=2)
        handle.write("\n")
    try:
        temporary_path.replace(path)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


def write_atomic(path, content):
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(content)
        temporary_path = Path(handle.name)
    try:
        temporary_path.replace(path)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


if __name__ == "__main__":
    main()