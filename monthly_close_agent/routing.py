"""Caller-side routing contract; no extra model or keyword classifier."""

DIRECT = "DIRECT_MOTOR"
RESEARCH = "P4_RESEARCH"


def validate_route(route, research_goal):
    if route == DIRECT:
        return False
    if route != RESEARCH or not isinstance(research_goal, str) or not research_goal.strip():
        raise ValueError("P4 requires an explicit research route and investigation goal")
    return True
