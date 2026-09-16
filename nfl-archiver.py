import re
import shutil
import tempfile
from pathlib import Path

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent
ARCHIVE_DIR = ROOT / "archives" / "2026"
ARCHIVE_FILE = ARCHIVE_DIR / "26_NFLEArch.htm"
ACTIVE_FILE = ROOT / "nfleTMP.htm"
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
    if not projected or not final:
        raise ValueError(f"Game {index}: final score is not populated")

    matchup = card.get("data-game", "").upper().split("-", 1)
    if len(matchup) != 2:
        raise ValueError(f"Game {index}: invalid matchup identifier")
    away, home = matchup
    line = parse_line(card)
    if not line:
        raise ValueError(f"Game {index}: missing point spread")
    line_team, spread = line
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
        summary[f"winner_{winner}"] += 1
        summary[f"ats_{ats}"] += 1
    summary["games"] = len(cards)
    return summary


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


def copy_atomic(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as handle:
        temporary_path = Path(handle.name)
    try:
        shutil.copyfile(source, temporary_path)
        temporary_path.replace(destination)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


def active_week_file():
    week, _ = parse_week(ACTIVE_FILE)
    weekly_file = ACTIVE_FILE.parent / f"nfle26-{week:02d}.htm"
    if not weekly_file.exists():
        raise FileNotFoundError(f"Expected generated weekly file: {weekly_file}")
    return week, weekly_file


def main():
    week, weekly_file = active_week_file()
    _, soup = parse_week(weekly_file)
    summary = summarize(soup)
    final_file = ARCHIVE_DIR / f"nfle26-{week:02d}F.htm"
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    copy_atomic(weekly_file, final_file)
    update_archive(week, summary)
    print(
        f"Archived Week {week}: {summary['winner_win']}-{summary['winner_loss']}-{summary['winner_push']} "
        f"straight up, {summary['ats_win']}-{summary['ats_loss']}-{summary['ats_push']} ATS -> {final_file}"
    )


if __name__ == "__main__":
    main()
