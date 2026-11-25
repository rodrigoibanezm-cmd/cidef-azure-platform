"""Inspect P3 evidence without upgrading its authority."""


def evidence_status(events):
    authorities = set()
    for event in events:
        if event.get("floor") != "P1" or event.get("status") != "SUCCESS":
            continue
        output = event.get("output_json") or {}
        candidates = [output]
        candidates.extend(item.get("evidence", {}) for item in output.get("results", [])
                          if isinstance(item, dict))
        for item in candidates:
            if isinstance(item, dict) and item.get("evidence_id"):
                authority = item.get("authority")
                if authority in {"P1_CERTIFIED", "P1_PARTIAL_SOURCE"}:
                    authorities.add(authority)
    if "P1_PARTIAL_SOURCE" in authorities:
        return "MIXED_OR_PARTIAL" if "P1_CERTIFIED" in authorities else "PARTIAL_ONLY"
    return "HAS_CERTIFIED_EVIDENCE" if authorities else "NO_EVIDENCE"


def decode_trace(trace):
    """Decode the MCP Python CallToolResult wire fields."""
    import json
    if trace.isError:
        raise RuntimeError("P3 no devolvió una traza válida")
    payload = trace.structuredContent
    if payload is None:
        payload = json.loads(next(c.text for c in trace.content if c.type == "text"))
    if not isinstance(payload, dict):
        raise ValueError("P3_INVALID_TRACE")
    return payload
