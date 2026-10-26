# OSS Lifeboat

**An AI-assisted guide to finding a starting point in open-source projects.**

OSS Lifeboat helps contributors explore public GitHub repositories by collecting project information, highlighting open issues, and generating an AI-assisted project briefing.

## Features

- **Repository overview:** View key metadata, including stars, forks, and open issues.
- **Project activity:** Inspect the latest commit and latest published release, when available.
- **Issue prioritisation:** Rank open issues using transparent rules based on labels and task-related signals.
- **AI-generated briefing:** Use Gemma 4 to summarise the available project evidence and suggest practical next steps.
- **Web interface:** Explore the results through a simple dashboard.
- **Automated tests:** Test the issue-ranking logic with pytest.

## Tech stack

- Python
- FastAPI
- GitHub REST API
- Google GenAI SDK and Gemma 4
- HTML, CSS and JavaScript
- pytest

## Requirements

- Python 3.11 or newer
- A Google Gemini API key with access to the configured model
- Optional GitHub personal access token for authenticated API requests

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/YOUR-USERNAME/OSS-Lifeboat.git
cd OSS-Lifeboat
```

Replace `YOUR-USERNAME` with your GitHub username.

### 2. Create and activate a virtual environment

**Windows PowerShell:**

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

### 3. Install dependencies

```bash
python -m pip install -r requirements.txt
```

### 4. Configure environment variables

Create a `.env` file in the project root:

```env
GEMINI_API_KEY=your_gemini_api_key
GITHUB_TOKEN=your_github_token
```

Keep your actual credentials private. Do not commit `.env` to GitHub. The GitHub token is optional if the application supports unauthenticated requests, but authenticated requests generally allow a higher API rate limit.

### 5. Start the application

```bash
python -m uvicorn app.main:app --reload
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000) in your browser.

Interactive API documentation is available at [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs).

## Run the tests

```bash
python -m pytest -v
```

The tests cover issue-ranking behaviour, score ordering, and handling of missing information.

## How issue ranking works

OSS Lifeboat uses explicit heuristic rules to prioritise issues. Labels such as `good first issue` and `help wanted`, certain task-related signals, and complexity labels can affect an issue's score.

These scores are **prioritisation hints, not guarantees of difficulty**. Always read the original issue and repository contribution guidelines before starting work.

## AI limitations

The AI-generated briefing is based on the information available to the application. It can make mistakes or miss important context. Verify recommendations against the repository and its documentation.

## Security and responsible use

- Only use public repositories that you are permitted to access.
- Keep API keys and tokens out of source control.
- Respect GitHub API rate limits and the relevant service terms.
- Verify issue details before acting on AI recommendations.

## Project status

Built as a Hacktoberfest Hack Day project at Queen Mary University of London, 24 October 2026.

## Licence

See the `LICENSE` file for licence terms.

## Project Deployment Link - Render

https://oss-lifeboat.onrender.com(https://oss-lifeboat.onrender.com)

