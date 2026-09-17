import re

# Comprehensive mapping dictionary for common API conventions
TEAM_MAP = {
    # NFC West
    'ARI': 'Arizona Cardinals', 'ARIZONA': 'Arizona Cardinals', 'CARDINALS': 'Arizona Cardinals',
    'LA': 'LA Rams', 'LAR': 'LA Rams', 'RAMS': 'LA Rams', 'LOS ANGELES RAMS': 'LA Rams',
    'SF': 'San Francisco 49ers', 'SAN FRANCISCO': 'San Francisco 49ers', '49ERS': 'San Francisco 49ers',
    'SEA': 'Seattle Seahawks', 'SEATTLE': 'Seattle Seahawks', 'SEAHAWKS': 'Seattle Seahawks',
    # NFC East
    'DAL': 'Dallas Cowboys', 'DALLAS': 'Dallas Cowboys', 'COWBOYS': 'Dallas Cowboys',
    'NYG': 'New York Giants', 'GIANTS': 'New York Giants',
    'PHI': 'Philadelphia Eagles', 'PHILADELPHIA': 'Philadelphia Eagles', 'EAGLES': 'Philadelphia Eagles',
    'WAS': 'Washington Commanders', 'WASHINGTON': 'Washington Commanders', 'COMMANDERS': 'Washington Commanders',
    # NFC North
    'CHI': 'Chicago Bears', 'CHICAGO': 'Chicago Bears', 'BEARS': 'Chicago Bears',
    'DET': 'Detroit Lions', 'DETROIT': 'Detroit Lions', 'LIONS': 'Detroit Lions',
    'GB': 'Green Bay Packers', 'GREEN BAY': 'Green Bay Packers', 'PACKERS': 'Green Bay Packers',
    'MIN': 'Minnesota Vikings', 'MINNESOTA': 'Minnesota Vikings', 'VIKINGS': 'Minnesota Vikings',
    # NFC South
    'ATL': 'Atlanta Falcons', 'ATLANTA': 'Atlanta Falcons', 'FALCONS': 'Atlanta Falcons',
    'CAR': 'Carolina Panthers', 'CAROLINA': 'Carolina Panthers', 'PANTHERS': 'Carolina Panthers',
    'NO': 'New Orleans Saints', 'NEW ORLEANS': 'New Orleans Saints', 'SAINTS': 'New Orleans Saints',
    'TB': 'Tampa Bay Buccaneers', 'TAMPA BAY': 'Tampa Bay Buccaneers', 'BUCCANEERS': 'Tampa Bay Buccaneers',
    # AFC West
    'DEN': 'Denver Broncos', 'DENVER': 'Denver Broncos', 'BRONCOS': 'Denver Broncos',
    'KC': 'Kansas City Chiefs', 'KANSAS CITY': 'Kansas City Chiefs', 'CHIEFS': 'Kansas City Chiefs',
    'LV': 'Las Vegas Raiders', 'LAS VEGAS': 'Las Vegas Raiders', 'RAIDERS': 'Las Vegas Raiders',
    'LAC': 'LA Chargers', 'CHARGERS': 'LA Chargers', 'LOS ANGELES CHARGERS': 'LA Chargers',
    # AFC East
    'BUF': 'Buffalo Bills', 'BUFFALO': 'Buffalo Bills', 'BILLS': 'Buffalo Bills',
    'MIA': 'Miami Dolphins', 'MIAMI': 'Miami Dolphins', 'DOLPHINS': 'Miami Dolphins',
    'NE': 'New England Patriots', 'NEW ENGLAND': 'New England Patriots', 'PATRIOTS': 'New England Patriots',
    'NYJ': 'New York Jets', 'JETS': 'New York Jets',
    # AFC North
    'BAL': 'Baltimore Ravens', 'BALTIMORE': 'Baltimore Ravens', 'RAVENS': 'Baltimore Ravens',
    'CIN': 'Cincinnati Bengals', 'CINCINNATI': 'Cincinnati Bengals', 'BENGALS': 'Cincinnati Bengals',
    'CLE': 'Cleveland Browns', 'CLEVELAND': 'Cleveland Browns', 'BROWNS': 'Cleveland Browns',
    'PIT': 'Pittsburgh Steelers', 'PITTSBURGH': 'Pittsburgh Steelers', 'STEELERS': 'Pittsburgh Steelers',
    # AFC South
    'HOU': 'Houston Texans', 'HOUSTON': 'Houston Texans', 'TEXANS': 'Houston Texans',
    'IND': 'Indianapolis Colts', 'INDIANAPOLIS': 'Indianapolis Colts', 'COLTS': 'Indianapolis Colts',
    'JAX': 'Jacksonville Jaguars', 'JACKSONVILLE': 'Jacksonville Jaguars', 'JAGUARS': 'Jacksonville Jaguars',
    'TEN': 'Tennessee Titans', 'TENNESSEE': 'Tennessee Titans', 'TITANS': 'Tennessee Titans'
}

def normalize_team(team_str, opponent_str=None):
    """
    Normalizes team names using 3-4 letter truncation prefixes, direct dictionary lookups,
    and fallback opponent context handling for shared-city scenarios (New York/LA).
    """
    if not team_str:
        return "Unknown"
        
    clean_name = str(team_str).strip().upper()
    
    # 1. Direct Explicit Key Match (E.g., "SEA", "NYJ")
    if clean_name in TEAM_MAP:
        return TEAM_MAP[clean_name]
        
    # 2. Check for Shared-City Ambiguities (New York and Los Angeles)
    if "NEW YORK" in clean_name or clean_name == "NY":
        if opponent_str:
            opp_clean = str(opponent_str).strip().upper()
            # Cross-reference with the opponent string to map out the accurate division team
            if any(x in opp_clean for x in ["BUF", "MIA", "NE", "BILLS", "DOLPHINS", "PATRIOTS"]):
                return "New York Jets"
            if any(x in opp_clean for x in ["DAL", "PHI", "WAS", "COWBOYS", "EAGLES", "COMMANDERS"]):
                return "New York Giants"
        # Alternate fallback if string contains distinct markers
        if "JET" in clean_name: return "New York Jets"
        if "GIANT" in clean_name: return "New York Giants"
        return "New York Team (Ambiguous)"

    if "LOS ANGELES" in clean_name or clean_name == "LA":
        if opponent_str:
            opp_clean = str(opponent_str).strip().upper()
            if any(x in opp_clean for x in ["DEN", "KC", "LV", "BRONCOS", "CHIEFS", "RAIDERS"]):
                return "LA Chargers"
            if any(x in opp_clean for x in ["ARI", "SF", "SEA", "CARDINALS", "49ERS", "SEAHAWKS"]):
                return "LA Rams"
        if "CHARGER" in clean_name: return "LA Chargers"
        if "RAM" in clean_name: return "LA Rams"
        return "LA Team (Ambiguous)"

    # 3. Truncated 3-to-4 Character Match Sequence
    for key, normalized_title in TEAM_MAP.items():
        if len(key) >= 3 and (key in clean_name or clean_name.startswith(key[:4])):
            return normalized_title

    return team_str.title()
