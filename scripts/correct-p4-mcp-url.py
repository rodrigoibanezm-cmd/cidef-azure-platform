"""Authorized configuration-only correction; verify target before changing P4."""
import json
import subprocess
import sys
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen


def az(*args):
    result = subprocess.run(["az", *args, "--only-show-errors", "-o", "json"],
                            capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError("AZURE_OPERATION_FAILED")
    return json.loads(result.stdout)


def main():
    app = ["--name", "cidef-p4", "--resource-group", "rg-cidef-prod"]
    motor = az("containerapp", "show", "--name", "cidef-motor-test-azure",
               "--resource-group", "rg-cidef-prod")
    host = motor["properties"]["configuration"]["ingress"]["fqdn"]
    config = az("containerapp", "show", *app)
    candidates = [c for c in config["properties"]["template"]["containers"]
                  if any(e["name"] == "MCP_URL" for e in c.get("env", []))]
    if len(candidates) != 1:
        raise RuntimeError("P4_CONTAINER_NOT_UNIQUE")
    container = candidates[0]
    entry = next(e for e in container["env"] if e["name"] == "MCP_URL")
    if entry.get("secretRef"):
        raise RuntimeError("MCP_URL_IS_SECRET_REFERENCE")
    old = urlsplit(entry["value"])
    if old.scheme != "https" or old.hostname != host or old.query or old.fragment or old.username or old.password:
        raise RuntimeError("UNEXPECTED_MCP_ENDPOINT")
    if old.path not in ("/mcp", "/api/mcp"):
        raise RuntimeError("UNEXPECTED_MCP_PATH")
    target = urlunsplit(("https", old.netloc, "/api/mcp", "", ""))
    request = Request(target, data=json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {},
    }).encode(), headers={"Content-Type": "application/json",
                         "Accept": "application/json, text/event-stream"})
    with urlopen(request, timeout=30) as response:
        raw = response.read().decode()
        if "text/event-stream" in response.headers.get("Content-Type", ""):
            raw = next(line[6:] for line in raw.splitlines() if line.startswith("data: "))
        names = {t["name"] for t in json.loads(raw)["result"]["tools"]}
    required = {"data_query", "p2_discover", "p2_describe", "p2_execute", "run_trace"}
    if not required.issubset(names):
        raise RuntimeError("TARGET_MISSING_UNIFIED_TOOLS")
    if old.path == "/api/mcp":
        print("PASS: already configured correctly")
        return
    az("containerapp", "update", *app, "--container-name", container["name"],
       "--set-env-vars", "MCP_URL=" + target)
    updated = az("containerapp", "show", *app)
    actual = next(c for c in updated["properties"]["template"]["containers"]
                  if c["name"] == container["name"])
    before = {e["name"]: e for e in container["env"] if e["name"] != "MCP_URL"}
    after = {e["name"]: e for e in actual["env"] if e["name"] != "MCP_URL"}
    if before != after or actual["image"] != container["image"]:
        raise RuntimeError("UNEXPECTED_CONFIG_CHANGE")
    if next(e for e in actual["env"] if e["name"] == "MCP_URL").get("value") != target:
        raise RuntimeError("URL_UPDATE_NOT_CONFIRMED")
    print("PASS: MCP_URL corrected; other environment entries and image unchanged")
    print("Revision:", updated["properties"].get("latestRevisionName"))


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as exc:
        raise SystemExit(str(exc)) from None
    except Exception as exc:
        raise SystemExit(type(exc).__name__) from None
