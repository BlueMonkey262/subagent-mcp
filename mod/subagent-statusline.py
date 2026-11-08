#!/usr/bin/env python3
"""Status line: one colored row per active subagent-mcp agent.

Row: Harness - model - Agent type - Agent name   elapsed · tokens so far
"""
import hashlib, json, os, re, sys, time
from datetime import datetime, timezone

LIVE = {"starting", "running", "needs_approval"}
BLUE, BOLD, DIM, RESET = "\033[34m", "\033[1m", "\033[2m", "\033[0m"
HARNESS_COLORS = {"codex": "\033[38;5;141m", "opencode": "\033[36m", "claude": "\033[38;5;208m",
                  "cursor": "\033[38;5;75m", "antigravity": "\033[38;5;204m"}  # purple, cyan, orange, sky blue, pink

def load_names():
    """Name pool shared with the server (src/agent-names.ts); only used for servers that don't send names."""
    try:
        src = open(os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "src", "agent-names.ts")).read()
        names = re.findall(r'^\s*"([A-Za-z-]+)",$', src, re.M)
        if names:
            return names
    except Exception:
        pass
    return ["Euler", "Gauss", "Turing", "Plato", "Athena", "Hermes"]

NAMES = load_names()

def elapsed(created):
    start = datetime.fromisoformat(created.replace("Z", "+00:00"))
    secs = max(0, int((datetime.now(timezone.utc) - start).total_seconds()))
    return f"{secs}s" if secs < 60 else f"{secs // 60}m{secs % 60:02d}s"

def compact(n):
    """1234 -> 1.2k, 1234567 -> 1.2M."""
    for size, suffix in ((1_000_000, "M"), (1_000, "k")):
        if n >= size:
            return f"{n / size:.1f}".rstrip("0").rstrip(".") + suffix
    return str(int(n))

def tokens(agent):
    """The agent's tokens so far (finished turns plus the live one).

    Splits input into new and cached when the backend says which is which (uncachedInputTokens);
    otherwise shows input as the backend reports it.
    """
    usage = agent.get("cumulative_usage") or {}
    num = lambda key: usage.get(key) if isinstance(usage.get(key), (int, float)) else None
    tin, tout, new, cached = num("inputTokens"), num("outputTokens"), num("uncachedInputTokens"), num("cachedInputTokens")
    if tin is None and tout is None:
        return ""
    out = f"{compact(tout or 0)} out"
    if new is not None and cached is not None:
        return f"{compact(new)} new · {compact(cached)} cached · {out}"
    return f"{compact(tin or 0)} in · {out}"

def assign_names(agents):
    """Stable name per agent from a hash of its id; a clash moves to the next free name."""
    taken, names = set(), {}
    for a in sorted(agents, key=lambda a: a["created_at"]):
        i = int(hashlib.sha1(a["agent_id"].encode()).hexdigest(), 16) % len(NAMES)
        while NAMES[i] in taken and len(taken) < len(NAMES):
            i = (i + 1) % len(NAMES)
        taken.add(NAMES[i])
        names[a["agent_id"]] = NAMES[i]
    return names

try:
    session = json.loads(sys.stdin.read() or "{}")
except Exception:
    session = {}
# the directories this session counts as its own project
here = {d for d in (session.get("cwd"), (session.get("workspace") or {}).get("project_dir"),
                    (session.get("workspace") or {}).get("current_dir")) if d}

# one live file per session (the mod writes <this dir>/subagent-strip/live/<session_id>.json), so sessions never overwrite each other
LIVE_DIR = os.path.join(os.path.dirname(os.path.realpath(__file__)), "subagent-strip", "live")
try:  # prune files of dead sessions (untouched for a day)
    d = LIVE_DIR
    for f in os.listdir(d):
        fp = os.path.join(d, f)
        if time.time() - os.path.getmtime(fp) > 86400:
            os.remove(fp)
except Exception:
    pass

try:
    live = json.load(open(os.path.join(LIVE_DIR, session["session_id"] + ".json")))
    if time.time() * 1000 - live["at"] > 10000:  # poller stopped; don't show ghosts
        sys.exit(0)
    agents = [a for a in live["agents"] if a.get("state") in LIVE]
except Exception:
    sys.exit(0)

saved = {}
for d in here:
    try:
        path = os.path.join(d, ".subagents", "memory", "sessions.json")
        saved.update({x["id"]: x for x in json.load(open(path))["agents"]})
    except Exception:
        pass
configs = {i: x.get("agentConfig", "") for i, x in saved.items()}
def in_project(agent_id):
    """An agent belongs here if it runs in this project, or in a managed worktree made from it."""
    rec = saved.get(agent_id, {})
    repo = ((rec.get("meta") or {}).get("worktree") or {}).get("repository")
    return rec.get("cwd") in here or (repo is not None and repo in here)

agents = [a for a in agents if in_project(a["agent_id"])]

# the server assigns each agent its name; hash only as a fallback for older servers
fallback = assign_names([a for a in agents if not a.get("name")])
sep = f" {DIM}-{RESET} "

# list_agents order isn't stable between polls; sort so rows never shuffle (oldest first, id breaks ties)
agents.sort(key=lambda a: (a.get("created_at", ""), a["agent_id"]))

for a in agents:
    backend = a.get("backend", "")
    config = configs.get(a["agent_id"], "").removeprefix(backend + "-").replace("-", " ").title()
    parts = [f"{HARNESS_COLORS.get(backend, '')}{backend.title()}{RESET}", a.get("model", "")]
    if config:
        parts.append(config)
    parts.append(f"{BOLD}{a.get('name') or fallback[a['agent_id']]}{RESET}")
    row = sep.join(parts)
    used = tokens(a)
    used = f" {DIM}·{RESET} {DIM}{used}{RESET}" if used else ""
    if a["state"] == "needs_approval":
        print(f"{BLUE}!{RESET} {row} {BLUE}needs approval{RESET}{used}")
    else:
        print(f"{row} {DIM}{elapsed(a['created_at'])}{RESET}{used}")
