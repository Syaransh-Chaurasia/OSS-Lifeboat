
import os

from dotenv import load_dotenv
from google import genai

load_dotenv(override=True)

AI_MODEL = os.getenv("GEMINI_MODEL", "gemma-4-26b-a4b-it").strip()


def get_gemini_client():
    """Create a Gemini client when an API key is configured."""
    api_key = (os.getenv("GEMINI_API_KEY") or "").strip()

    if not api_key:
        return None

    # The SDK prefers GOOGLE_API_KEY when both variables exist. OSS Lifeboat
    # explicitly uses GEMINI_API_KEY so an unrelated Google key cannot route
    # requests to the wrong project.
    os.environ.pop("GOOGLE_API_KEY", None)
    return genai.Client(api_key=api_key)


async def generate_project_brief(repository: dict, issues: list[dict]) -> str:
    """Generate an evidence-based summary of a repository and its issues."""

    client = get_gemini_client()

    if client is None:
        return (
            "AI briefing is unavailable because GEMINI_API_KEY "
            "is not configured. Repository data is still available."
        )

    issue_evidence = [
        {
            "title": issue.get("title"),
            "url": issue.get("url"),
            "labels": issue.get("labels", []),
            "score": issue.get("score"),
            "reasons": issue.get("reasons", []),
        }
        for issue in issues[:5]
    ]

    prompt = f"""
You are the AI assistant for OSS Lifeboat, an open-source contribution helper.

Use only the supplied evidence. Do not invent repository facts, claim that
a repository is secure, or promise that an issue is easy to solve.

Repository evidence:
{repository}

Ranked issue evidence:
{issue_evidence}

Write a concise briefing with:
1. What this project does, based only on the supplied description.
2. What the available activity and release evidence tells us.
3. Which issue looks most promising to investigate and why.
4. Three practical steps a beginner could take before contributing.

Clearly identify missing evidence. Treat rule-based issue scores as estimates,
not facts about difficulty. Keep the response under 250 words.
"""

    try:
        response = await client.aio.models.generate_content(
            model=AI_MODEL,
            contents=prompt,
        )
        return response.text or "Gemini returned an empty briefing."


    except Exception as exc:
        print(f"Gemini request failed: {type(exc).__name__}: {exc}")
        return (
            "AI briefing is temporarily unavailable. "
            f"The provider returned {type(exc).__name__}."
        )

async def generate_comparison_brief(snapshot_a: dict, snapshot_b: dict) -> str:
    """Generate a short comparison of two saved repository snapshots."""
    client = get_gemini_client()

    if client is None:
        return (
            "AI comparison is unavailable because GEMINI_API_KEY "
            "is not configured."
        )

    repo_a = snapshot_a.get("repository", {})
    repo_b = snapshot_b.get("repository", {})

    issues_a = snapshot_a.get("issueData", {}).get("issues", [])[:3]
    issues_b = snapshot_b.get("issueData", {}).get("issues", [])[:3]

    prompt = f"""
You are the OSS Lifeboat AI assistant. Compare these two repositories for a beginner open-source contributor based ONLY on this data:

Repository A ({repo_a.get('name', 'First repo')}):
- Stars: {repo_a.get('stars', 0)} | Forks: {repo_a.get('forks', 0)} | Open Issues: {repo_a.get('open_issues', 0)}
- Sample Beginner Issues: {[i.get('title') for i in issues_a]}

Repository B ({repo_b.get('name', 'Second repo')}):
- Stars: {repo_b.get('stars', 0)} | Forks: {repo_b.get('forks', 0)} | Open Issues: {repo_b.get('open_issues', 0)}
- Sample Beginner Issues: {[i.get('title') for i in issues_b]}

Write a concise comparison (max 3 short paragraphs):
1. How their activity and community size compare.
2. Which one has better beginner-friendly issues right now.
3. Your final recommendation on which one to pick first.

Do not invent repository facts. Clearly identify missing evidence.
"""

    try:
        response = await client.aio.models.generate_content(
            model=AI_MODEL,
            contents=prompt,
        )
        return response.text or "No comparison generated."
    except Exception as exc:
        print(f"Gemini comparison failed: {type(exc).__name__}: {exc}")
        return (
            "AI comparison is temporarily unavailable. "
            f"The provider returned {type(exc).__name__}."
        )