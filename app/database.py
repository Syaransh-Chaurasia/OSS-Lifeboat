"""SQLite persistence for OSS Lifeboat analysis history.

The browser receives a random session token in an HttpOnly cookie. Only a
SHA-256 hash of that token is stored in SQLite. This separates casual demo
visitors, but is not a substitute for authenticated accounts.

History rules
-------------
* One row per repository per session (case-insensitive).
* Saving a repository that already exists UPDATES that row (same id) and
  moves it to the top of the list - it never creates a duplicate.
* A unique index enforces the rule at the database level as well.
"""

import hashlib
import json
import os
import secrets
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATABASE_PATH = PROJECT_ROOT / "oss_lifeboat.db"
DATABASE_PATH = Path(os.getenv("DATABASE_PATH", str(DEFAULT_DATABASE_PATH))).expanduser()

_init_lock = threading.Lock()
_initialised_path: Path | None = None


def utc_now() -> str:
    """Return an ISO-8601 UTC timestamp."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def _connect():
    """Open a configured SQLite connection and always close it."""
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def init_db(force: bool = False) -> None:
    """Create tables once per process (cheap no-op on later calls)."""
    global _initialised_path

    if not force and _initialised_path == DATABASE_PATH:
        return

    with _init_lock:
        if not force and _initialised_path == DATABASE_PATH:
            return

        with _connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS anonymous_sessions (
                    id TEXT PRIMARY KEY,
                    token_hash TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS analyses (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    repository_full_name TEXT NOT NULL,
                    repository_url TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    snapshot_json TEXT NOT NULL,
                    FOREIGN KEY (session_id)
                        REFERENCES anonymous_sessions(id)
                        ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_analyses_session_created
                ON analyses(session_id, created_at DESC);
                """
            )

            # Remove any duplicates left over from older versions, keeping
            # the most recent row per repository, THEN enforce uniqueness.
            connection.execute(
                """
                DELETE FROM analyses
                WHERE id NOT IN (
                    SELECT MAX(id)
                    FROM analyses
                    GROUP BY session_id, LOWER(repository_full_name)
                )
                """
            )
            connection.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS idx_analyses_session_repo
                ON analyses(session_id, LOWER(repository_full_name))
                """
            )

        _initialised_path = DATABASE_PATH


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def resolve_session(token: str | None = None) -> tuple[str, str, bool]:
    """Return (cookie token, session ID, whether a new session was created)."""
    init_db()

    if token:
        token_hash = _hash_token(token)
        with _connect() as connection:
            row = connection.execute(
                "SELECT id FROM anonymous_sessions WHERE token_hash = ?",
                (token_hash,),
            ).fetchone()
            if row:
                connection.execute(
                    "UPDATE anonymous_sessions SET last_seen_at = ? WHERE id = ?",
                    (utc_now(), row["id"]),
                )
                return token, str(row["id"]), False

    new_token = secrets.token_urlsafe(32)
    session_id = str(uuid.uuid4())
    now = utc_now()

    with _connect() as connection:
        connection.execute(
            """
            INSERT INTO anonymous_sessions (id, token_hash, created_at, last_seen_at)
            VALUES (?, ?, ?, ?)
            """,
            (session_id, _hash_token(new_token), now, now),
        )

    return new_token, session_id, True


def save_analysis(
    session_id: str,
    repository_full_name: str,
    repository_url: str,
    snapshot: dict[str, Any],
) -> dict[str, Any]:
    """Insert OR update the single snapshot kept for a repository.

    Returns the public summary, including ``updated`` (True when an existing
    entry was refreshed instead of a new one being created).
    """
    init_db()
    created_at = utc_now()
    snapshot_json = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))

    with _connect() as connection:
        # Take the write lock up-front so two simultaneous saves of the same
        # repository cannot both decide to INSERT.
        connection.execute("BEGIN IMMEDIATE")

        existing = connection.execute(
            """
            SELECT id FROM analyses
            WHERE session_id = ?
              AND LOWER(repository_full_name) = LOWER(?)
            ORDER BY id DESC
            LIMIT 1
            """,
            (session_id, repository_full_name),
        ).fetchone()

        if existing:
            analysis_id = existing["id"]
            connection.execute(
                """
                UPDATE analyses
                SET repository_full_name = ?,
                    repository_url = ?,
                    created_at = ?,
                    snapshot_json = ?
                WHERE id = ?
                """,
                (
                    repository_full_name,
                    repository_url,
                    created_at,
                    snapshot_json,
                    analysis_id,
                ),
            )
            updated = True
        else:
            cursor = connection.execute(
                """
                INSERT INTO analyses (
                    session_id, repository_full_name, repository_url,
                    created_at, snapshot_json
                )
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    repository_full_name,
                    repository_url,
                    created_at,
                    snapshot_json,
                ),
            )
            analysis_id = cursor.lastrowid
            updated = False

    return {
        "id": analysis_id,
        "repository": repository_full_name,
        "url": repository_url,
        "created_at": created_at,
        "updated": updated,
    }


def _parse_json(value: Any) -> Any:
    if value is None:
        return None
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return None


def list_history(session_id: str, limit: int = 20) -> list[dict[str, Any]]:
    """List recent saved analyses (with light summary data) for one session."""
    init_db()
    safe_limit = max(1, min(int(limit), 100))

    with _connect() as connection:
        rows = connection.execute(
            """
            SELECT id,
                   repository_full_name,
                   repository_url,
                   created_at,
                   json_extract(snapshot_json, '$.summary')            AS summary_json,
                   json_extract(snapshot_json, '$.repository.stars')   AS stars,
                   json_extract(snapshot_json, '$.repository.forks')   AS forks,
                   json_extract(snapshot_json, '$.repository.language') AS language,
                   json_extract(snapshot_json, '$.repository.description') AS description
            FROM analyses
            WHERE session_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            """,
            (session_id, safe_limit),
        ).fetchall()

    history = []
    for row in rows:
        summary = row["summary_json"]
        if isinstance(summary, str):
            summary = _parse_json(summary)
        if not isinstance(summary, dict):
            summary = {}

        history.append(
            {
                "id": row["id"],
                "repository": row["repository_full_name"],
                "url": row["repository_url"],
                "created_at": row["created_at"],
                "stars": row["stars"],
                "forks": row["forks"],
                "language": row["language"],
                "description": row["description"],
                "summary": summary,
            }
        )

    return history


def get_analysis(session_id: str, analysis_id: int) -> dict[str, Any] | None:
    """Return a saved snapshot only when it belongs to the given session."""
    init_db()
    with _connect() as connection:
        row = connection.execute(
            """
            SELECT id, repository_full_name, repository_url,
                   created_at, snapshot_json
            FROM analyses
            WHERE id = ? AND session_id = ?
            """,
            (analysis_id, session_id),
        ).fetchone()

    if row is None:
        return None

    snapshot = _parse_json(row["snapshot_json"])
    if not isinstance(snapshot, dict):
        snapshot = {}

    return {
        "id": row["id"],
        "repository": row["repository_full_name"],
        "url": row["repository_url"],
        "created_at": row["created_at"],
        "snapshot": snapshot,
    }


def delete_analysis(session_id: str, analysis_id: int) -> bool:
    """Delete an analysis owned by the given session."""
    init_db()
    with _connect() as connection:
        cursor = connection.execute(
            "DELETE FROM analyses WHERE id = ? AND session_id = ?",
            (analysis_id, session_id),
        )
        return cursor.rowcount > 0


def clear_history(session_id: str) -> int:
    """Delete every analysis owned by the given session; return the count."""
    init_db()
    with _connect() as connection:
        cursor = connection.execute(
            "DELETE FROM analyses WHERE session_id = ?",
            (session_id,),
        )
        return cursor.rowcount