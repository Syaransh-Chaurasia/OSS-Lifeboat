
import json
import os
from pathlib import Path
from urllib.parse import urlparse

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.database import (
    delete_analysis,
    get_analysis,
    init_db,
    list_history,
    resolve_session,
    save_analysis,
)
from app.services.ai_service import (
    generate_comparison_brief,
    generate_project_brief,
)
from app.services.github_service import fetch_github_data
from app.services.issue_ranker import rank_issues


load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"

SESSION_COOKIE_NAME = "oss_lifeboat_session"
SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 60

COOKIE_SECURE = (
    os.getenv("COOKIE_SECURE", "false").strip().lower()
    in {"1", "true", "yes", "on"}
)

app = FastAPI(
    title="OSS Lifeboat",
    description="Evidence-based open-source project intelligence.",
    version="0.5.0",
)

GITHUB_API = "https://api.github.com"

GITHUB_HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}

github_token = os.getenv("GITHUB_TOKEN")

if github_token:
    GITHUB_HEADERS["Authorization"] = f"Bearer {github_token}"


app.mount(
    "/static",
    StaticFiles(directory=STATIC_DIR),
    name="static",
)


class SaveAnalysisRequest(BaseModel):
    """Request body used to save a completed repository analysis."""

    repository: str = Field(min_length=3, max_length=200)
    url: str = Field(min_length=10, max_length=300)
    snapshot: dict = Field(default_factory=dict)


def set_session_cookie(response: Response, token: str) -> None:
    """Set a server-issued, HTTP-only anonymous session cookie."""
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        max_age=SESSION_COOKIE_MAX_AGE,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


def require_session(request: Request, response: Response) -> str:
    """Resolve the current anonymous session and set a cookie if needed."""
    token = request.cookies.get(SESSION_COOKIE_NAME)

    resolved_token, session_id, is_new = resolve_session(token)

    if is_new:
        set_session_cookie(response, resolved_token)

    return session_id


def parse_github_url(repository_url: str) -> tuple[str, str]:
    """Extract the owner and repository name from a public GitHub URL."""
    try:
        parsed = urlparse(repository_url.strip())
        port = parsed.port
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="Enter a valid public GitHub repository URL.",
        )

    hostname = (parsed.hostname or "").lower()
    if hostname.startswith("www."):
        hostname = hostname[4:]

    if (
        parsed.scheme not in {"https", "http"}
        or hostname != "github.com"
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 80, 443)
        or parsed.query
        or parsed.fragment
    ):
        raise HTTPException(
            status_code=400,
            detail="Enter a valid public GitHub repository URL.",
        )

    parts = parsed.path.strip("/").split("/")

    if (
        len(parts) != 2
        or not all(parts)
        or parts[0].startswith(".")
        or parts[1].startswith(".")
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                "Use a repository URL in the format "
                "https://github.com/owner/repo."
            ),
        )

    owner, repository = parts

    if repository.endswith(".git"):
        repository = repository[:-4]

    if not repository:
        raise HTTPException(
            status_code=400,
            detail="The repository name is missing.",
        )

    return owner, repository


async def fetch_repository_metadata(
    owner: str,
    repository: str,
) -> dict:
    """Fetch basic metadata for a public GitHub repository."""
    api_url = f"{GITHUB_API}/repos/{owner}/{repository}"

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                api_url,
                headers=GITHUB_HEADERS,
            )

    except httpx.TimeoutException:
        raise HTTPException(
            status_code=504,
            detail="GitHub took too long to respond. Please try again.",
        )

    except httpx.RequestError:
        raise HTTPException(
            status_code=502,
            detail="Could not connect to GitHub. Check your connection.",
        )

    if response.status_code == 404:
        raise HTTPException(
            status_code=404,
            detail="Repository not found or not publicly accessible.",
        )

    if response.status_code in (403, 429):
        remaining = response.headers.get("x-ratelimit-remaining")
        reset = response.headers.get("x-ratelimit-reset")

        if remaining == "0":
            detail = (
                "GitHub API rate limit reached. Wait for the reset time "
                "and check that GITHUB_TOKEN is configured correctly."
            )

            if reset:
                detail += f" Reset timestamp: {reset}."

        else:
            detail = (
                "GitHub restricted this request. Check your token, "
                "permissions, or retry after a short wait."
            )

        raise HTTPException(
            status_code=503,
            detail=detail,
        )

    if response.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail="GitHub returned an unexpected response.",
        )

    data = response.json()
    license_data = data.get("license")

    return {
        "name": data["full_name"],
        "description": data.get("description"),
        "url": data["html_url"],
        "stars": data["stargazers_count"],
        "forks": data["forks_count"],
        "open_issues": data["open_issues_count"],
        "default_branch": data["default_branch"],
        "language": data.get("language"),
        "license": (
            {
                "name": license_data.get("name"),
                "spdx_id": license_data.get("spdx_id"),
            }
            if license_data
            else None
        ),
        "created_at": data["created_at"],
        "updated_at": data["updated_at"],
    }


@app.on_event("startup")
async def startup_database() -> None:
    """Ensure the SQLite schema exists before serving requests."""
    init_db()


@app.get("/", include_in_schema=False)
async def home():
    """Serve the OSS Lifeboat web interface."""
    return FileResponse(TEMPLATES_DIR / "index.html")


@app.get("/api/health")
async def health_check():
    """Confirm that the backend is running."""
    return {
        "status": "ok",
        "service": "OSS Lifeboat",
    }


@app.get("/api/session")
async def get_anonymous_session(
    request: Request,
    response: Response,
):
    """Establish an anonymous browser session before API requests."""
    require_session(request, response)

    return {
        "status": "ok",
        "history_scope": "this browser session",
    }


@app.get("/api/repository")
async def get_repository(
    url: str = Query(
        ...,
        min_length=10,
        max_length=300,
        description="Public GitHub repository URL",
    ),
):
    """Return basic metadata for a public GitHub repository."""
    owner, repository = parse_github_url(url)

    return await fetch_repository_metadata(owner, repository)


@app.get("/api/repository/health")
async def get_repository_health(
    url: str = Query(
        ...,
        min_length=10,
        max_length=300,
        description="Public GitHub repository URL",
    ),
):
    """Return repository metadata and supporting GitHub evidence."""
    owner, repository = parse_github_url(url)

    metadata = await fetch_repository_metadata(owner, repository)
    github_data = await fetch_github_data(owner, repository)

    activity = github_data["activity"]
    release = github_data["release"]
    issues = github_data["issues"]

    activity_evidence = None

    if activity["available"] and activity["data"]:
        latest_commit = activity["data"][0]
        commit_details = latest_commit.get("commit", {})
        author_details = commit_details.get("author") or {}

        activity_evidence = {
            "latest_commit": commit_details.get(
                "message",
                "Commit message unavailable",
            ),
            "commit_url": latest_commit.get("html_url"),
            "committed_at": author_details.get("date"),
        }

    release_evidence = None

    if release["available"]:
        latest_release = release["data"]

        release_evidence = {
            "tag": latest_release.get("tag_name"),
            "name": latest_release.get("name"),
            "published_at": latest_release.get("published_at"),
            "url": latest_release.get("html_url"),
        }

    issue_evidence = None

    if issues["available"]:
        issue_evidence = [
            {
                "title": issue.get("title"),
                "url": issue.get("html_url"),
                "created_at": issue.get("created_at"),
                "labels": [
                    label.get("name", "")
                    for label in issue.get("labels", [])
                ],
            }
            for issue in issues["data"]
            if "pull_request" not in issue
        ]

    return {
        "repository": metadata,
        "checks": {
            "recent_activity": {
                "available": activity["available"],
                "evidence": activity_evidence,
                "error": activity.get("error"),
            },
            "latest_release": {
                "available": release["available"],
                "evidence": release_evidence,
                "error": release.get("error"),
            },
            "open_issues": {
                "available": issues["available"],
                "evidence": issue_evidence,
                "error": issues.get("error"),
            },
        },
    }


@app.get("/api/repository/issues")
async def get_ranked_issues(
    url: str = Query(
        ...,
        min_length=10,
        max_length=300,
        description="Public GitHub repository URL",
    ),
):
    """Return open issues ranked using transparent beginner signals."""
    owner, repository = parse_github_url(url)
    github_data = await fetch_github_data(owner, repository)

    issue_result = github_data["issues"]

    if not issue_result["available"]:
        raise HTTPException(
            status_code=503,
            detail=issue_result.get(
                "error",
                "Could not retrieve issues.",
            ),
        )

    ranked = rank_issues(issue_result["data"])

    return {
        "repository": f"{owner}/{repository}",
        "ranking_method": (
            "Transparent heuristic using beginner-friendly labels, "
            "contribution invitations, task-type signals, and complexity "
            "labels. Scores are prioritisation hints, not guarantees "
            "of difficulty."
        ),
        "issues_found": len(ranked),
        "issues": ranked,
    }


@app.get("/api/repository/brief")
async def get_repository_brief(
    url: str = Query(
        ...,
        min_length=10,
        max_length=300,
        description="Public GitHub repository URL",
    ),
):
    """Generate an AI briefing grounded in real GitHub evidence."""
    owner, repository = parse_github_url(url)

    metadata = await fetch_repository_metadata(owner, repository)
    github_data = await fetch_github_data(owner, repository)

    activity = github_data["activity"]
    release = github_data["release"]
    issue_result = github_data["issues"]

    latest_commit = None

    if activity["available"] and activity["data"]:
        commit = activity["data"][0]
        commit_details = commit.get("commit", {})
        author_details = commit_details.get("author") or {}

        latest_commit = {
            "message": commit_details.get(
                "message",
                "Commit message unavailable",
            ),
            "url": commit.get("html_url"),
            "date": author_details.get("date"),
        }

    latest_release = None

    if release["available"]:
        release_data = release["data"]

        latest_release = {
            "tag": release_data.get("tag_name"),
            "name": release_data.get("name"),
            "published_at": release_data.get("published_at"),
            "url": release_data.get("html_url"),
        }

    issues = (
        rank_issues(issue_result["data"])
        if issue_result["available"]
        else []
    )

    evidence = {
        **metadata,
        "latest_commit": latest_commit,
        "latest_release": latest_release,
        "issue_retrieval": (
            "available"
            if issue_result["available"]
            else issue_result.get("error", "unavailable")
        ),
    }

    briefing = await generate_project_brief(evidence, issues)

    return {
        "repository": metadata["name"],
        "briefing": briefing,
        "issues_considered": len(issues),
        "evidence": {
            "latest_commit": latest_commit,
            "latest_release": latest_release,
            "issue_data_available": issue_result["available"],
        },
    }


@app.post("/api/history")
async def create_history_entry(
    payload: SaveAnalysisRequest,
    request: Request,
    response: Response,
):
    """Save a completed analysis snapshot to the current browser history."""
    session_id = require_session(request, response)

    owner, repository = parse_github_url(payload.url)
    canonical_name = f"{owner}/{repository}"

    # Do not store arbitrarily large client-supplied snapshots.
    snapshot_size = len(
        json.dumps(payload.snapshot, ensure_ascii=False)
    )

    if snapshot_size > 500_000:
        raise HTTPException(
            status_code=413,
            detail="This analysis snapshot is too large to save.",
        )

    saved = save_analysis(
        session_id=session_id,
        repository_full_name=canonical_name,
        repository_url=f"https://github.com/{owner}/{repository}",
        snapshot=payload.snapshot,
    )

    return {
        "status": "saved",
        "analysis": saved,
    }


@app.get("/api/history")
async def get_history(
    request: Request,
    response: Response,
    limit: int = Query(default=20, ge=1, le=100),
):
    """List saved analysis summaries for this browser session."""
    session_id = require_session(request, response)

    return {
        "history": list_history(session_id, limit=limit),
    }


@app.get("/api/history/{analysis_id}")
async def get_history_entry(
    analysis_id: int,
    request: Request,
    response: Response,
):
    """Retrieve a snapshot only if it belongs to this browser session."""
    session_id = require_session(request, response)
    saved = get_analysis(session_id, analysis_id)

    if saved is None:
        raise HTTPException(
            status_code=404,
            detail="Saved analysis not found.",
        )

    return saved


@app.delete("/api/history/{analysis_id}")
async def remove_history_entry(
    analysis_id: int,
    request: Request,
    response: Response,
):
    """Delete a saved snapshot owned by this browser session."""
    session_id = require_session(request, response)

    if not delete_analysis(session_id, analysis_id):
        raise HTTPException(
            status_code=404,
            detail="Saved analysis not found.",
        )

    return {
        "status": "deleted",
        "id": analysis_id,
    }


class CompareRequest(BaseModel):
    first_id: int
    second_id: int

@app.post("/api/repository/compare-brief")
async def get_repository_comparison_brief(
    payload: CompareRequest,
    request: Request,
    response: Response,
):
    """Generate a Gemma 4 comparison brief between two saved snapshots."""
    if payload.first_id == payload.second_id:
        raise HTTPException(
            status_code=400,
            detail="Choose two different saved analyses to compare.",
        )

    session_id = require_session(request, response)
    first_entry = get_analysis(session_id, payload.first_id)
    second_entry = get_analysis(session_id, payload.second_id)

    if not first_entry or not second_entry:
        raise HTTPException(
            status_code=404,
            detail="One or both saved analyses were not found.",
        )

    briefing = await generate_comparison_brief(
        first_entry["snapshot"],
        second_entry["snapshot"],
    )

    return {
        "first_repository": first_entry["repository"],
        "second_repository": second_entry["repository"],
        "comparison_brief": briefing,
    }