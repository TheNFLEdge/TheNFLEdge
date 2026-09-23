import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from nfl_team_resolver import normalize_team
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent
ARCHIVE_DIR = ROOT / "archives" / "2026"
ARCHIVE_FILE = ARCHIVE_DIR / "26_NFLEArch.htm"
ACTIVE_FILE = ROOT / "nfleTMP.htm"
STATE_FILE = ROOT / "nfl_rotation_state.json"
WEEKLY_FILE_PATTERN = re.compile(r"nfle26-(\d{1,2})\.htm$", re.IGNORECASE)
SCORE_PATTERN = re.compile(r"\b[A-Z0-9]{2,4}\s+(-?\d+)\s*-\s*[A-Z0-9]{2,4}\s+(-?\d+)\b")
LINE_PATTERN = re.compile(r"\b([A-Z0-9]{2,4})\s+([+-]\d+(?:\.\d+)?)\b")


def parse_score(cell):
    text = cell.get_text(" ", strip=True)
    marker = str(cell)
    if not text or "FINAL-SCORE-" in marker.upper() or "TBD" in text.upper():
        return None
    match = SCORE_PATTERN.search(text)
    return (int(match.group(1)), int(match.group(2))) if match else None


def parse_line(card):
    line = card.find("p", class_="line")
    if not line:
        return None
    match = LINE_PATTERN.search(line.get_text(" ", strip=True).upper())
    return (match.group(1), float(match.group(2))) if match else None


def parse_week(html_path):
    soup = BeautifulSoup(html_path.read_text(encoding="utf-8"), "html.parser")
    heading = soup.find("h1")
    match = re.search(r"Week\s+(\d+)\s+Picks", heading.get_text(" ", strip=True), re.IGNORECASE) if heading else None
    if not match:
        raise ValueError(f"Could not determine week from {html_path}")
    return int(match.group(1)), soup


def classify_card(card, index):
    projected_cell = card.find(string=re.compile(r"Projected Score", re.IGNORECASE))
    final_cell = card.find(string=re.compile(r"Final Score", re.IGNORECASE))
    if not projected_cell or not final_cell:
        raise ValueError(f"Game {index}: missing projected or final score row")

    projected = parse_score(projected_cell.find_parent("td").find_next_sibling("td"))
    final = parse_score(final_cell.find_parent("td").find_next_sibling("td"))
    
    # --- GRACEFUL ERROR HANDLING PATCH START ---
    if not projected or not final:
        print(f" -> Game {index}: Final score text cell is blank or unpopulated in HTML. Skipping recording counters.")
        return None, None
    # --- GRACEFUL ERROR HANDLING PATCH END ---

    matchup = card.get("data-game", "").upper().split("-", 1)
    if len(matchup) != 2:
        raise ValueError(f"Game {index}: invalid matchup identifier")
    
    # Apply your new nfl_team_resolver normalization directly to the HTML attributes
    raw_away, raw_home = matchup
    away = normalize_team(raw_away, raw_home)
    home = normalize_team(raw_home, raw_away)
    
    line = parse_line(card)
    if not line:
        raise ValueError(f"Game {index}: missing point spread")
    line_team_raw, spread = line
    line_team = normalize_team(line_team_raw)
    
    if line_team not in (away, home):
        raise ValueError(f"Game {index}: spread team {line_team} is not in {away}-{home}")

    projected_margin = projected[0] - projected[1]
    final_margin = final[0] - final[1]
    winner_result = (projected_margin > 0) - (projected_margin < 0)
    final_result = (final_margin > 0) - (final_margin < 0)
    winner = "win" if winner_result and winner_result == final_result else "loss" if winner_result else "push"

    projected_line_margin = projected[0] - projected[1] if line_team == away else projected[1] - projected[0]
    final_line_margin = final[0] - final[1] if line_team == away else final[1] - final[0]
    projected_cover = projected_line_margin + spread
    final_cover = final_line_margin + spread
    if projected_cover == 0:
        ats = "push"
    elif final_cover == 0 or (projected_cover > 0) == (final_cover > 0):
        ats = "win"
    else:
        ats = "loss"
    return winner, ats


def summarize(soup):
    cards = soup.select("article.game-card")
    if not cards:
        raise ValueError("No article.game-card elements found")
    summary = {"winner_win": 0, "winner_loss": 0, "winner_push": 0, "ats_win": 0, "ats_loss": 0, "ats_push": 0}
    for index, card in enumerate(cards, start=1):
        winner, ats = classify_card(card, index)
        # --- SAFETY CHECK ---
        if winner is None:
            continue
        # -------------------------------
        summary[f"winner_{winner}"] += 1
        summary[f"ats_{ats}"] += 1
    summary["games"] = len(cards)
    return summary


def week_is_complete(soup):
    return not incomplete_game_diagnostics(soup)


def incomplete_game_diagnostics(soup):
    cards = soup.select("article.game-card")
    if not cards:
        return ["no article.game-card elements found"]
    diagnostics = []
    for index, card in enumerate(cards, start=1):
        final_cell = card.find(string=re.compile(r"Final Score", re.IGNORECASE))
        if not final_cell:
            diagnostics.append(f"Game {index}: missing Final Score row")
            continue
        score_cell = final_cell.find_parent("td").find_next_sibling("td")
        if not score_cell or parse_score(score_cell) is None:
            matchup = card.get("data-game", "?")
            raw_cell = str(score_cell) if score_cell else "<no sibling td found>"
            diagnostics.append(f"Game {index} ({matchup}): final score is not populated -- raw cell: {raw_cell}")
    return diagnostics


def percentage(wins, losses):
    total = wins + losses
    return f"{wins / total * 100:.2f}%" if total else "0.00%"


def row_html(week, summary):
    return (
        f'<tr data-week="{week}">'
        f'<td><a href="./nfle26-{week:02d}F.htm">Week {week}</a></td>'
        f'<td>{summary["winner_win"]}-{summary["winner_loss"]}-{summary["winner_push"]}</td>'
        f'<td>{percentage(summary["winner_win"], summary["winner_loss"])}</td>'
        f'<td>{summary["ats_win"]}-{summary["ats_loss"]}-{summary["ats_push"]}</td>'
        f'<td>{percentage(summary["ats_win"], summary["ats_loss"])}</td>'
        f'</tr>'
    )


def update_totals(table):
    totals = {key: 0 for key in ("winner_win", "winner_loss", "winner_push", "ats_win", "ats_loss", "ats_push")}
    for row in table.select("tr[data-week]"):
        values = [re.findall(r"\d+", cell.get_text()) for cell in row.find_all("td")]
        if len(values) < 4 or len(values[1]) < 3 or len(values[3]) < 3:
            continue
        totals["winner_win"] += int(values[1][0])
        totals["winner_loss"] += int(values[1][1])
        totals["winner_push"] += int(values[1][2])
        totals["ats_win"] += int(values[3][0])
        totals["ats_loss"] += int(values[3][1])
        totals["ats_push"] += int(values[3][2])

    total_row = table.select_one("tr#season-total")
    if not total_row:
        total_row = BeautifulSoup('<tr id="season-total"><td>Season total</td><td></td><td></td><td></td><td></td></tr>', "html.parser").tr
        table.append(total_row)
    cells = total_row.find_all("td")
    cells[1].string = f'{totals["winner_win"]}-{totals["winner_loss"]}-{totals["winner_push"]}'
    cells[2].string = percentage(totals["winner_win"], totals["winner_loss"])
    cells[3].string = f'{totals["ats_win"]}-{totals["ats_loss"]}-{totals["ats_push"]}'
    cells[4].string = percentage(totals["ats_win"], totals["ats_loss"])


def update_archive(week, summary):
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    soup = BeautifulSoup(ARCHIVE_FILE.read_text(encoding="utf-8"), "html.parser")
    table = soup.select_one("table#weekly-results")
    if not table:
        raise ValueError(f"No weekly-results table found in {ARCHIVE_FILE}")
    new_row = BeautifulSoup(row_html(week, summary), "html.parser").tr
    existing = table.select_one(f'tr[data-week="{week}"]')
    if existing:
        existing.replace_with(new_row)
    else:
        total_row = table.select_one("tr#season-total")
        if total_row:
            total_row.insert_before(new_row)
        else:
            table.append(new_row)
    update_totals(table)
    atomic_write(ARCHIVE_FILE, str(soup))


def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(content)
        temporary_path = Path(handle.name)
    try:
        temporary_path.replace(path)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


def move_atomic(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    source.replace(destination)


def active_week_file():
    if not STATE_FILE.exists():
        raise RuntimeError("Rotation state validation failed: nfl_rotation_state.json is missing")
    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Rotation state validation failed: invalid JSON ({error})") from error
    week = state.get("active_week")
    issue = state.get("active_issue")
    if state.get("schema_version") != 1 or state.get("season") != int(os.getenv("NFL_SEASON", "2026")):
        raise RuntimeError("Rotation state validation failed: unsupported schema or season mismatch")
    if not isinstance(week, int) or not 1 <= week <= 18 or not isinstance(issue, str) or issue != f"nfle26-{week:02d}.htm" or "/" in issue or "\\" in issue:
        raise RuntimeError("Rotation state validation failed: unsafe or inconsistent canonical issue")

    active_issue = STATE_FILE.parent / issue
    archived_issue = ARCHIVE_DIR / f"nfle26-{week:02d}F.htm"
    # fall back to the archived copy if a prior run archived this week but never advanced rotation state
    weekly_file = active_issue if active_issue.exists() else archived_issue

    if not weekly_file.exists():
        raise FileNotFoundError(
            f"Expected canonical weekly file at {active_issue} or archived copy at {archived_issue}"
        )
    actual_hash = canonical_sha256(weekly_file)
    if actual_hash != state.get("active_issue_sha256"):
        raise RuntimeError("Rotation state validation failed: canonical issue checksum mismatch")
    heading_week, _ = parse_week(weekly_file)
    if heading_week != week:
        raise RuntimeError(f"Rotation state validation failed: canonical heading is Week {heading_week}, expected Week {week}")

    already_archived = weekly_file == archived_issue
    if already_archived:
        print(f"Notice: Week {week} was already archived to {archived_issue} in a prior run; skipping re-archive.")
    return week, weekly_file, already_archived


def canonical_sha256(path):
    content = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def main():
    week, weekly_file, already_archived = active_week_file()

    if already_archived:
        print(f"Week {week} archive already complete ({weekly_file.name} found in archives/2026). Nothing further to do.")
        return

    _, soup = parse_week(weekly_file)
    diagnostics = incomplete_game_diagnostics(soup)

    if diagnostics:
        print("\n" + "="*80)
        print(f"ERROR: Week {week} has unpopulated scores ({'; '.join(diagnostics)}).")
        print("Refusing to archive an incomplete week. Re-run after all games are final.")
        print("="*80 + "\n")
        raise RuntimeError(f"Week {week} archive blocked: {len(diagnostics)} incomplete game(s)")

    print(f"Success: All game scores for Week {week} are fully populated.")
    summary = summarize(soup)
    final_file = ARCHIVE_DIR / f"nfle26-{week:02d}F.htm"
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    move_atomic(weekly_file, final_file)
    update_archive(week, summary)
    print(
        f"Archived Week {week}: {summary['winner_win']}-{summary['winner_loss']}-{summary['winner_push']} "
        f"straight up, {summary['ats_win']}-{summary['ats_loss']}-{summary['ats_push']} ATS -> {final_file}"
    )


if __name__ == "__main__":
    main()
