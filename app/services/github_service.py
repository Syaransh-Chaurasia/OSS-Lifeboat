
import asyncio
import os

import httpx
from dotenv import load_dotenv

load_dotenv()

GITHUB_API = "https://api.github.com"

HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}

github_token = os.getenv("GITHUB_TOKEN")

if github_token:
    HEADERS["Authorization"] = f"Bearer {github_token}"


def make_unavailable(error: str) -> dict:
    """Return a consistent structure for an unavailable GitHub check."""
    return {
        "available": False,
        "error": error,
    }


async def fetch_github_data(owner: str, repository: str) -> dict:
    """Fetch recent activity, latest release, and open issues."""
    base_url = f"{GITHUB_API}/repos/{owner}/{repository}"

    endpoints = {
        "activity": f"{base_url}/commits?per_page=1",
        "release": f"{base_url}/releases/latest",
        "issues": f"{base_url}/issues?state=open&per_page=100",
    }

    async with httpx.AsyncClient(
        timeout=10.0,
        headers=HEADERS,
    ) as client:
        responses = await asyncio.gather(
            *(client.get(url) for url in endpoints.values()),
            return_exceptions=True,
        )

    results = {}

    for key, response in zip(endpoints.keys(), responses):
        if isinstance(response, Exception):
            results[key] = make_unavailable(
                "GitHub could not be reached for this check."
            )
            continue

        if response.status_code == 200:
            data = response.json()

            if key == "issues":
                # GitHub's issues endpoint also includes pull requests.
                # Exclude those and keep a small sample for this MVP.
                data = [
                    issue
                    for issue in data
                    if "pull_request" not in issue
                ][:10]

            results[key] = {
                "available": True,
                "data": data,
            }
            continue

        if key == "release" and response.status_code == 404:
            results[key] = make_unavailable(
                "No published release was found."
            )
            continue

        if response.status_code in (403, 429):
            remaining = response.headers.get("x-ratelimit-remaining")
            reset = response.headers.get("x-ratelimit-reset")

            if remaining == "0":
                message = (
                    "GitHub API rate limit reached. Wait for the quota "
                    "to reset and verify that GITHUB_TOKEN is configured."
                )

                if reset:
                    message += f" Reset timestamp: {reset}."
            else:
                message = (
                    "GitHub restricted this request. Check token "
                    "permissions or try again after a short wait."
                )

            results[key] = make_unavailable(message)
            continue

        results[key] = make_unavailable(
            f"GitHub returned status {response.status_code}."
        )

    return results
