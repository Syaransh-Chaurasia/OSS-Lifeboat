
"""
Transparent, heuristic-based ranking for open-source issues.

Scores help newcomers prioritise issues to investigate. They do not
predict the actual effort required to solve an issue.
"""

BEGINNER_LABELS = {
    "good first issue",
    "beginner",
    "easy",
    "first timers only",
}

HELP_WANTED_LABELS = {
    "help wanted",
    "contributions welcome",
}

SIMPLE_TASK_LABELS = {
    "documentation",
    "docs",
    "tests",
    "testing",
    "typo",
}

COMPLEX_LABELS = {
    "epic",
    "breaking change",
    "major refactor",
}

APPROACHABLE_TERMS = (
    "documentation",
    "docs",
    "typo",
    "spelling mistake",
    "add a test",
    "unit test",
    "example",
)


def rank_issue(issue: dict) -> dict:
    """Score an issue using explicit labels and cautious task signals."""
    labels = {
        label.get("name", "").strip().lower()
        for label in issue.get("labels", [])
        if label.get("name")
    }

    title = (issue.get("title") or "").strip()
    body = (issue.get("body") or "").strip()
    searchable_text = f"{title} {body}".lower()

    score = 0
    reasons = []

    if labels & BEGINNER_LABELS:
        score += 5
        reasons.append(
            "Has a label explicitly identifying it as beginner-friendly"
        )

    if labels & HELP_WANTED_LABELS:
        score += 2
        reasons.append(
            "Maintainers have invited community contributions"
        )

    if labels & SIMPLE_TASK_LABELS:
        score += 2
        reasons.append(
            "Has a documentation, testing, or typo-related label"
        )

    if any(term in searchable_text for term in APPROACHABLE_TERMS):
        score += 1
        reasons.append(
            "Title or description mentions a potentially contained task"
        )

    if labels & COMPLEX_LABELS:
        score -= 4
        reasons.append(
            "Has a label that may indicate substantial complexity"
        )

    if not reasons:
        reasons.append(
            "No strong beginner-friendly signals were found; review manually"
        )

    score = max(score, 0)

    if score >= 5:
        difficulty_estimate = "Promising for beginners"
    elif score >= 2:
        difficulty_estimate = "Potentially approachable — review first"
    else:
        difficulty_estimate = "Needs further review"

    return {
        "title": title or "Untitled issue",
        "url": issue.get("html_url"),
        "labels": sorted(labels),
        "score": score,
        "reasons": reasons,
        "difficulty_estimate": difficulty_estimate,
    }


def rank_issues(issues: list[dict]) -> list[dict]:
    """Sort issues by their beginner-friendly signals."""
    ranked = [rank_issue(issue) for issue in issues]

    return sorted(
        ranked,
        key=lambda item: item["score"],
        reverse=True,
    )
