"""Read-only live endpoint smoke check: no SDK run or paid model calls."""
import json
import os
import time
import urllib.request
import urllib.error

url = os.environ["P4_TEST_URL"]
token = os.environ["P4_TEST_TOKEN"]

def call(method, params, auth=True):
    data = json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode()
    headers = {"Content-Type":"application/json","Accept":"application/json, text/event-stream"}
    if auth:
        headers["Authorization"] = "Bearer " + token
    with urllib.request.urlopen(urllib.request.Request(url,data=data,headers=headers),timeout=30) as response:
        return json.load(response)["result"]

for attempt in range(12):
    try:
        tools = call("tools/list", {})["tools"]
        assert [tool["name"] for tool in tools] == ["commercial_analyze"]
        try:
            call("tools/list", {}, auth=False)
        except urllib.error.HTTPError as exc:
            assert exc.code == 401
        else:
            raise AssertionError("Unauthenticated discovery was accepted")
        result = call("tools/call", {"name":"commercial_analyze","arguments":
            {"question":"consulta directa","route":"DIRECT_MOTOR","research_goal":""}})
        assert result["structuredContent"]["status"] == "DIRECT_MOTOR"
        print("PASS: authenticated MCP discovery, unauthenticated rejection and direct bypass")
        break
    except (OSError, KeyError, ValueError) as exc:
        if attempt == 11:
            raise RuntimeError("MCP smoke check failed") from exc
        time.sleep(5)
