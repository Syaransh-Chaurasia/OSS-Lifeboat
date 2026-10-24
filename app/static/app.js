const form = document.querySelector("#analyze-form");
const urlInput = document.querySelector("#repo-url");
const analyzeButton = document.querySelector("#analyze-button");
const buttonLabel = document.querySelector("#button-label");
const statusMessage = document.querySelector("#status-message");
const results = document.querySelector("#results");
const issueSearch = document.querySelector("#issue-search");
const issueSort = document.querySelector("#issue-sort");
const saveButton = document.querySelector("#save-analysis-button");

let currentIssues = [];
let currentSnapshot = null;
let historyEntries = [];
let selectedHistoryIds = new Set();
let historyLoadingPromise = null;

const COLORS = {
    promising: "#5ce1bb",
    potential: "#45d8f5",
    review: "#b59aff",
    cyan: "#45d8f5",
    neutral: "#293c55",
};

function setStatus(message, type = "") {
    statusMessage.textContent = message;
    statusMessage.classList.toggle("error", type === "error");
    statusMessage.classList.toggle("loading", type === "loading");
}

function addTextElement(parent, tag, className, text) {
    const element = document.createElement(tag);
    if (className) {
        element.className = className;
    }
    element.textContent = text == null ? "" : String(text);
    parent.appendChild(element);
    return element;
}

function addSafeLink(parent, text, url, className = "") {
    if (typeof url !== "string" || !/^https:\/\/github\.com\//i.test(url)) {
        return addTextElement(parent, "span", className, text);
    }
    const link = document.createElement("a");
    link.textContent = text;
    link.href = url;
    link.className = className;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    parent.appendChild(link);
    return link;
}

function getGithubRepositoryUrl(repositoryUrl) {
    if (typeof repositoryUrl !== "string") return null;
    try {
        const parsed = new URL(repositoryUrl);
        if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
            return null;
        }
        const parts = parsed.pathname.split("/").filter(Boolean);
        if (parts.length < 2) return null;
        return `https://github.com/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
    } catch {
        return null;
    }
}

function githubIssuesUrl(query = "is:issue is:open") {
    const base = getGithubRepositoryUrl(currentSnapshot?.repository?.url);
    if (!base) return null;
    return `${base}/issues?q=${encodeURIComponent(query)}`;
}

function openGithubUrl(url) {
    if (typeof url !== "string" || !/^https:\/\/github\.com\//i.test(url)) return;
    window.open(url, "_blank", "noopener,noreferrer");
}

function ensureDrawerChrome() {
    let backdrop = document.querySelector("#drawer-backdrop");
    if (!backdrop) {
        backdrop = document.createElement("button");
        backdrop.id = "drawer-backdrop";
        backdrop.className = "drawer-backdrop";
        backdrop.type = "button";
        backdrop.setAttribute("aria-label", "Close navigation panel");
        backdrop.hidden = true;
        backdrop.addEventListener("click", () => showView("analyse"));
        document.body.appendChild(backdrop);
    }

    for (const [viewId, label] of [["history-view", "History"], ["compare-view", "Compare"]]) {
        const view = document.getElementById(viewId);
        if (!view) continue;
        view.classList.add("drawer-view");
        if (!view.querySelector(".drawer-header")) {
            const header = document.createElement("div");
            header.className = "drawer-header";
            const title = document.createElement("div");
            title.className = "drawer-header-copy";
            addTextElement(title, "span", "eyebrow", "OSS LIFEBOAT WORKSPACE");
            addTextElement(title, "strong", "drawer-title", label);

            const close = document.createElement("button");
            close.className = "drawer-close-button";
            close.type = "button";
            close.setAttribute("aria-label", `Close ${label} panel`);
            close.textContent = "×";
            close.addEventListener("click", () => showView("analyse"));

            header.append(title, close);
            view.prepend(header);
        }
        view.setAttribute("aria-hidden", "true");
    }
}

function formatNumber(value) {
    const number = Number(value);
    return Number.isFinite(number)
        ? new Intl.NumberFormat().format(number)
        : "Not available";
}

function svgEl(name, attrs = {}) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attrs)) {
        element.setAttribute(key, String(value));
    }
    return element;
}

function repositoryKey(value) {
    const fromUrl = getGithubRepositoryUrl(value);
    if (fromUrl) {
        return fromUrl.replace(/\/+$/, "").toLowerCase();
    }
    return String(value || "").trim().replace(/\/+$/, "").toLowerCase();
}

function uniqueHistoryEntries(entries) {
    const seen = new Set();
    const unique = [];
    for (const entry of entries) {
        const key = repositoryKey(entry.url) || repositoryKey(entry.repository);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        unique.push(entry);
    }
    return unique;
}

function formatDate(value) {
    if (!value) {
        return "Date not available";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "Date not available";
    }
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(date);
}

function clearResults() {
    const ids = [
        "stats-grid",
        "signals-list",
        "issues-list",
        "briefing",
        "label-chart",
        "priority-legend",
        "score-histogram",
        "readiness-chart",
    ];
    for (const id of ids) {
        document.getElementById(id)?.replaceChildren();
    }
    document.querySelector("#priority-donut").style.background =
        `conic-gradient(${COLORS.neutral} 0deg 360deg)`;
    document.querySelector("#label-empty").hidden = true;
    document.querySelector("#score-empty").hidden = true;
    document.querySelector("#readiness-empty").hidden = true;
    document.querySelector("#issue-count-note").textContent = "";
    currentIssues = [];
}

function animateNumber(element, target, suffix = "") {
    const numericTarget = Number(target);
    if (!Number.isFinite(numericTarget) || numericTarget < 0) {
        element.textContent = "Not available";
        return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        element.textContent = `${formatNumber(numericTarget)}${suffix}`;
        return;
    }
    const duration = 550;
    const startTime = performance.now();

    function frame(now) {
        const progress = Math.min((now - startTime) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = Math.round(numericTarget * eased);
        element.textContent = `${formatNumber(current)}${suffix}`;
        if (progress < 1) {
            requestAnimationFrame(frame);
        }
    }
    requestAnimationFrame(frame);
}

function renderStats(repository) {
    const grid = document.querySelector("#stats-grid");
    grid.replaceChildren();

    const stats = [
        {
            label: "Stars",
            value: repository.stars,
            icon: "★",
            glow: "#45d8f5",
            note: "GitHub stars • open on GitHub",
            numeric: true,
            path: "/stargazers",
        },
        {
            label: "Forks",
            value: repository.forks,
            icon: "⑂",
            glow: "#b59aff",
            note: "Repository forks • open on GitHub",
            numeric: true,
            path: "/network/members",
        },
        {
            label: "Open issues",
            value: repository.open_issues,
            icon: "☉",
            glow: "#5ce1bb",
            note: "GitHub issues • open on GitHub",
            numeric: true,
            path: "/issues",
        },
        {
            label: "Main language",
            value: repository.language || "Not specified",
            icon: "</>",
            glow: "#ffb86c",
            note: "As reported by GitHub • view repository",
            numeric: false,
            path: "",
        },
    ];

    for (const stat of stats) {
        const card = document.createElement("a");
        card.className = "stat-card stat-card-link";
        const repositoryUrl = getGithubRepositoryUrl(repository.url);
        card.href = repositoryUrl ? `${repositoryUrl}${stat.path}` : "#";
        if (repositoryUrl) {
            card.target = "_blank";
            card.rel = "noopener noreferrer";
        } else {
            card.setAttribute("aria-disabled", "true");
            card.addEventListener("click", (event) => event.preventDefault());
        }
        card.setAttribute("aria-label", `${stat.label}: ${stat.value ?? "Not available"}. Open related GitHub page.`);
        card.style.setProperty("--glow", stat.glow);

        const topline = document.createElement("div");
        topline.className = "stat-topline";
        addTextElement(topline, "div", "stat-label", stat.label);
        const icon = addTextElement(topline, "div", "stat-icon", stat.icon);
        icon.setAttribute("aria-hidden", "true");
        card.appendChild(topline);

        const value = addTextElement(card, "div", "stat-value", "0");
        if (stat.numeric && stat.value != null) {
            animateNumber(value, stat.value);
        } else {
            value.textContent =
                stat.value == null ? "Not available" : String(stat.value);
        }

        addTextElement(card, "div", "stat-footnote", stat.note);
        grid.appendChild(card);
    }
}

function renderAnalysisOverview(repository, health, issueData) {
    const freshness = document.querySelector("#analysis-freshness");
    const coverage = document.querySelector("#analysis-coverage");
    const signal = document.querySelector("#analysis-signal");
    const checks = health?.checks ?? {};
    const availableChecks = Object.values(checks).filter(
        (check) => check?.available
    ).length;
    const totalChecks = Object.keys(checks).length;
    const issues = Array.isArray(issueData?.issues) ? issueData.issues : [];
    const beginnerCount = issues.filter((issue) =>
        getIssueLabels(issue).some(isBeginnerLabel)
    ).length;

    freshness.textContent = repository.updated_at
        ? `Updated on GitHub ${formatDate(repository.updated_at)}.`
        : "GitHub update timing was not available.";
    coverage.textContent = totalChecks
        ? `${availableChecks} of ${totalChecks} supporting checks returned evidence.`
        : "Supporting GitHub checks were not available.";
    signal.textContent = issues.length
        ? `${beginnerCount} of ${issues.length} retrieved issues show beginner signals.`
        : "No ranked issue sample was available.";
}

function renderSignals(health) {
    const container = document.querySelector("#signals-list");
    container.replaceChildren();

    const checks = health?.checks ?? {};

    const activity = checks.recent_activity;
    const activityItem = document.createElement("article");
    activityItem.className = "signal-item";
    addTextElement(activityItem, "div", "signal-title", "Recent commit");
    if (activity?.available && activity.evidence) {
        const evidence = activity.evidence;
        addTextElement(
            activityItem,
            "p",
            "signal-detail",
            `${evidence.latest_commit || "Commit message unavailable"} • ${formatDate(evidence.committed_at)}`
        );
        if (evidence.commit_url) {
            addSafeLink(
                activityItem,
                "Open commit ↗",
                evidence.commit_url,
                "text-link"
            );
        }
    } else {
        addTextElement(
            activityItem,
            "p",
            "signal-detail",
            activity?.error || "Recent activity could not be retrieved."
        );
    }
    container.appendChild(activityItem);

    const release = checks.latest_release;
    const releaseItem = document.createElement("article");
    releaseItem.className = "signal-item";
    addTextElement(
        releaseItem,
        "div",
        "signal-title",
        "Latest published release"
    );
    if (release?.available && release.evidence) {
        const evidence = release.evidence;
        addTextElement(
            releaseItem,
            "p",
            "signal-detail",
            `${evidence.name || evidence.tag || "Release"} • ${formatDate(evidence.published_at)}`
        );
        if (evidence.url) {
            addSafeLink(
                releaseItem,
                "View release ↗",
                evidence.url,
                "text-link"
            );
        }
    } else {
        addTextElement(
            releaseItem,
            "p",
            "signal-detail",
            release?.error || "No release evidence is available."
        );
    }
    container.appendChild(releaseItem);

    const issueCheck = checks.open_issues;
    const issueItem = document.createElement("article");
    issueItem.className = "signal-item";
    addTextElement(issueItem, "div", "signal-title", "Issue evidence");
    const retrievedCount = Array.isArray(issueCheck?.evidence)
        ? issueCheck.evidence.length
        : null;
    addTextElement(
        issueItem,
        "p",
        "signal-detail",
        issueCheck?.available
            ? `${retrievedCount ?? "Some"} issue records retrieved for this check.`
            : issueCheck?.error || "Issue data could not be retrieved."
    );
    container.appendChild(issueItem);
}

function getIssueLabels(issue) {
    if (!Array.isArray(issue?.labels)) {
        return [];
    }
    return issue.labels
        .map((label) => {
            if (typeof label === "string") {
                return label.trim();
            }
            if (label && typeof label.name === "string") {
                return label.name.trim();
            }
            return "";
        })
        .filter(Boolean);
}

function isBeginnerLabel(label) {
    const normalised = label.toLowerCase().replace(/[-_]/g, " ").trim();
    return [
        "good first issue",
        "beginner",
        "easy",
        "first timers only",
        "first timers welcome",
    ].includes(normalised);
}

function getPriority(issue) {
    const estimate = String(
        issue?.difficulty_estimate || ""
    ).toLowerCase();
    if (estimate.includes("promising for beginners")) {
        return "promising";
    }
    if (estimate.includes("potentially approachable")) {
        return "potential";
    }
    return "review";
}

function renderAnalytics(issueData) {
    const issues = Array.isArray(issueData?.issues)
        ? issueData.issues
        : [];
    const allLabels = issues.flatMap(getIssueLabels);
    const labelCounts = new Map();
    for (const label of allLabels) {
        labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
    }

    const beginnerCount = issues.filter((issue) =>
        getIssueLabels(issue).some(isBeginnerLabel)
    ).length;

    animateNumber(
        document.querySelector("#total-analysed"),
        issues.length
    );
    animateNumber(
        document.querySelector("#labelled-count"),
        issues.filter((issue) => getIssueLabels(issue).length > 0).length
    );
    animateNumber(
        document.querySelector("#beginner-count"),
        beginnerCount
    );
    animateNumber(
        document.querySelector("#donut-total"),
        issues.length
    );

    renderLabelChart(labelCounts);
    renderPriorityChart(issues);
    renderScoreHistogram(issues);
    renderReadinessChart(issues, beginnerCount);

    const summaryLinks = [
        ["total-analysed", "is:issue is:open", "Open open GitHub issues"],
        ["labelled-count", "is:issue is:open has:label", "Open labelled GitHub issues"],
        ["beginner-count", 'is:issue is:open label:"good first issue"', "Open good-first-issue results"],
    ];

    for (const [id, query, label] of summaryLinks) {
        const metric = document.getElementById(id);
        const wrapper = metric?.parentElement;
        const href = githubIssuesUrl(query);
        if (!metric || !wrapper || wrapper.classList.contains("issue-summary-link")) continue;

        const link = document.createElement("a");
        link.className = "issue-summary-link";
        link.href = href || "#";
        link.setAttribute("aria-label", label);
        if (href) {
            link.target = "_blank";
            link.rel = "noopener noreferrer";
        } else {
            link.addEventListener("click", (event) => event.preventDefault());
        }
        wrapper.parentNode.insertBefore(link, wrapper);
        link.appendChild(wrapper);
    }
}

function renderLabelChart(labelCounts) {
    const chart = document.querySelector("#label-chart");
    const emptyMessage = document.querySelector("#label-empty");
    chart.replaceChildren();

    const sorted = [...labelCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 6);

    if (sorted.length === 0) {
        emptyMessage.hidden = false;
        return;
    }

    emptyMessage.hidden = true;
    const maxCount = Math.max(...sorted.map((entry) => entry[1]));

    sorted.forEach(([label, count], index) => {
        const row = document.createElement("a");
        row.className = "bar-row bar-row-link";
        const labelUrl = githubIssuesUrl(`is:issue is:open label:"${label.replace(/"/g, "")}"`);
        row.href = labelUrl || "#";
        if (labelUrl) {
            row.target = "_blank";
            row.rel = "noopener noreferrer";
        } else {
            row.addEventListener("click", (event) => event.preventDefault());
        }
        row.title = `Open GitHub issues with the label: ${label}`;
        row.style.animationDelay = `${index * 45}ms`;

        addTextElement(row, "span", "bar-label", label);

        const track = document.createElement("div");
        track.className = "bar-track";
        track.setAttribute("role", "img");
        track.setAttribute("aria-label", `${label}: ${count} issues`);

        const fill = document.createElement("div");
        fill.className = "bar-fill";
        fill.style.width = "0%";
        track.appendChild(fill);
        row.appendChild(track);

        addTextElement(row, "span", "bar-count", count);
        chart.appendChild(row);

        requestAnimationFrame(() => {
            fill.style.width = `${(count / maxCount) * 100}%`;
        });
    });
}

function renderPriorityChart(issues) {
    const donut = document.querySelector("#priority-donut");
    const legend = document.querySelector("#priority-legend");

    const groups = [
        {
            key: "promising",
            label: "Promising for beginners",
            color: COLORS.promising,
            count: 0,
        },
        {
            key: "potential",
            label: "Potentially approachable",
            color: COLORS.potential,
            count: 0,
        },
        {
            key: "review",
            label: "Needs further review",
            color: COLORS.review,
            count: 0,
        },
    ];

    for (const issue of issues) {
        const group = groups.find(
            (item) => item.key === getPriority(issue)
        );
        if (group) {
            group.count += 1;
        }
    }

    legend.replaceChildren();
    let currentDegree = 0;
    const segments = [];

    for (const group of groups) {
        const degrees = issues.length
            ? (group.count / issues.length) * 360
            : 0;
        if (degrees > 0) {
            segments.push(
                `${group.color} ${currentDegree}deg ${currentDegree + degrees}deg`
            );
            currentDegree += degrees;
        }

        const row = document.createElement("a");
        row.className = "legend-row legend-row-link";
        const issuesUrl = githubIssuesUrl("is:issue is:open");
        row.href = issuesUrl || "#";
        if (issuesUrl) {
            row.target = "_blank";
            row.rel = "noopener noreferrer";
        } else {
            row.addEventListener("click", (event) => event.preventDefault());
        }
        row.title = "Open the repository's GitHub issues. Priority is an OSS Lifeboat estimate, not a GitHub label.";

        const swatch = document.createElement("span");
        swatch.className = "legend-swatch";
        swatch.style.background = group.color;
        swatch.setAttribute("aria-hidden", "true");
        row.appendChild(swatch);

        addTextElement(row, "span", "legend-label", group.label);
        addTextElement(row, "span", "legend-count", group.count);
        legend.appendChild(row);
    }

    if (!segments.length) {
        donut.style.background =
            `conic-gradient(${COLORS.neutral} 0deg 360deg)`;
        donut.setAttribute("aria-label", "No issues available");
        return;
    }

    donut.style.background = `conic-gradient(${segments.join(", ")})`;
    donut.setAttribute(
        "aria-label",
        groups.map((group) => `${group.label}: ${group.count}`).join("; ")
    );
}

function renderScoreHistogram(issues) {
    const chart = document.querySelector("#score-histogram");
    const empty = document.querySelector("#score-empty");
    chart.replaceChildren();

    if (!issues.length) {
        empty.hidden = false;
        return;
    }

    empty.hidden = true;
    const buckets = [
        { label: "0", min: 0, max: 0, color: COLORS.review },
        { label: "1–2", min: 1, max: 2, color: COLORS.potential },
        { label: "3–4", min: 3, max: 4, color: COLORS.cyan || "#45d8f5" },
        { label: "5+", min: 5, max: 99, color: COLORS.promising },
    ];
    for (const issue of issues) {
        const score = Number(issue.score) || 0;
        const bucket = buckets.find((item) => score >= item.min && score <= item.max);
        if (bucket) bucket.count = (bucket.count || 0) + 1;
    }

    const maxCount = Math.max(...buckets.map((item) => item.count || 0), 1);
    const width = 360;
    const height = 180;
    const padding = { top: 16, right: 12, bottom: 36, left: 28 };
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;
    const barWidth = innerWidth / buckets.length - 16;

    const svg = svgEl("svg", {
        viewBox: `0 0 ${width} ${height}`,
        class: "plot-svg",
        role: "img",
    });

    buckets.forEach((bucket, index) => {
        const count = bucket.count || 0;
        const barHeight = (count / maxCount) * innerHeight;
        const x = padding.left + index * (innerWidth / buckets.length) + 8;
        const y = padding.top + innerHeight - barHeight;
        const rect = svgEl("rect", {
            x,
            y,
            width: barWidth,
            height: Math.max(barHeight, 2),
            rx: 6,
            fill: bucket.color,
        });
        svg.appendChild(rect);

        const value = svgEl("text", {
            x: x + barWidth / 2,
            y: y - 6,
            "text-anchor": "middle",
            class: "plot-label",
        });
        value.textContent = String(count);
        svg.appendChild(value);

        const axis = svgEl("text", {
            x: x + barWidth / 2,
            y: height - 12,
            "text-anchor": "middle",
            class: "plot-axis",
        });
        axis.textContent = bucket.label;
        svg.appendChild(axis);
    });

    chart.appendChild(svg);
}

function renderReadinessChart(issues, beginnerCount) {
    const chart = document.querySelector("#readiness-chart");
    const empty = document.querySelector("#readiness-empty");
    chart.replaceChildren();

    if (!issues.length) {
        empty.hidden = false;
        return;
    }

    empty.hidden = true;
    const labelled = issues.filter((issue) => getIssueLabels(issue).length > 0).length;
    const remaining = Math.max(issues.length - beginnerCount, 0);
    const rows = [
        { label: "Beginner signals", value: beginnerCount, color: COLORS.promising },
        { label: "Labelled issues", value: labelled, color: COLORS.potential },
        { label: "Needs review", value: remaining, color: COLORS.review },
    ];
    const maxValue = Math.max(...rows.map((row) => row.value), 1);
    const width = 360;
    const height = 180;
    const svg = svgEl("svg", {
        viewBox: `0 0 ${width} ${height}`,
        class: "plot-svg",
    });

    rows.forEach((row, index) => {
        const y = 28 + index * 48;
        const label = svgEl("text", { x: 0, y, class: "plot-axis" });
        label.textContent = row.label;
        svg.appendChild(label);

        const track = svgEl("rect", {
            x: 0,
            y: y + 8,
            width: 360,
            height: 14,
            rx: 7,
            fill: "#1c304a",
        });
        svg.appendChild(track);

        const fill = svgEl("rect", {
            x: 0,
            y: y + 8,
            width: Math.max((row.value / maxValue) * 360, 4),
            height: 14,
            rx: 7,
            fill: row.color,
        });
        svg.appendChild(fill);

        const value = svgEl("text", {
            x: 360,
            y,
            "text-anchor": "end",
            class: "plot-label",
        });
        value.textContent = String(row.value);
        svg.appendChild(value);
    });

    chart.appendChild(svg);
}

function priorityGroups(issues) {
    const groups = [
        { key: "promising", label: "Promising", color: COLORS.promising, count: 0 },
        { key: "potential", label: "Approachable", color: COLORS.potential, count: 0 },
        { key: "review", label: "Review", color: COLORS.review, count: 0 },
    ];
    for (const issue of issues) {
        const group = groups.find((item) => item.key === getPriority(issue));
        if (group) group.count += 1;
    }
    return groups;
}

function renderComparisonRadar(container, firstRepo, secondRepo, countsA, countsB) {
    container.replaceChildren();
    const metrics = [
        { label: "Stars", a: Number(firstRepo.stars) || 0, b: Number(secondRepo.stars) || 0 },
        { label: "Forks", a: Number(firstRepo.forks) || 0, b: Number(secondRepo.forks) || 0 },
        { label: "Open issues", a: Number(firstRepo.open_issues) || 0, b: Number(secondRepo.open_issues) || 0 },
        { label: "Analysed", a: countsA.analysed, b: countsB.analysed },
        { label: "Beginner", a: countsA.beginner, b: countsB.beginner },
    ];
    const size = 280;
    const center = size / 2;
    const radius = 92;
    const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, class: "plot-svg" });

    for (let ring = 1; ring <= 3; ring += 1) {
        svg.appendChild(svgEl("circle", {
            cx: center,
            cy: center,
            r: (radius * ring) / 3,
            fill: "none",
            stroke: "rgba(126, 170, 218, 0.18)",
        }));
    }

    function pointsFor(key) {
        return metrics.map((metric, index) => {
            const max = Math.max(metric.a, metric.b, 1);
            const value = metric[key] / max;
            const angle = (-Math.PI / 2) + (index * (2 * Math.PI / metrics.length));
            const x = center + Math.cos(angle) * radius * value;
            const y = center + Math.sin(angle) * radius * value;
            return `${x},${y}`;
        }).join(" ");
    }

    metrics.forEach((metric, index) => {
        const angle = (-Math.PI / 2) + (index * (2 * Math.PI / metrics.length));
        const x = center + Math.cos(angle) * (radius + 22);
        const y = center + Math.sin(angle) * (radius + 22);
        svg.appendChild(svgEl("line", {
            x1: center,
            y1: center,
            x2: center + Math.cos(angle) * radius,
            y2: center + Math.sin(angle) * radius,
            stroke: "rgba(126, 170, 218, 0.2)",
        }));
        const text = svgEl("text", {
            x,
            y,
            "text-anchor": "middle",
            class: "plot-axis",
        });
        text.textContent = metric.label;
        svg.appendChild(text);
    });

    svg.appendChild(svgEl("polygon", {
        points: pointsFor("a"),
        fill: "rgba(69, 216, 245, 0.22)",
        stroke: COLORS.potential,
        "stroke-width": 2,
    }));
    svg.appendChild(svgEl("polygon", {
        points: pointsFor("b"),
        fill: "rgba(181, 154, 255, 0.22)",
        stroke: COLORS.review,
        "stroke-width": 2,
    }));
    container.appendChild(svg);
}

function renderComparisonPriority(container, snapshotA, snapshotB, nameA, nameB) {
    container.replaceChildren();
    for (const item of [
        { snapshot: snapshotA, name: nameA },
        { snapshot: snapshotB, name: nameB },
    ]) {
        const issues = Array.isArray(item.snapshot?.issueData?.issues)
            ? item.snapshot.issueData.issues
            : [];
        const groups = priorityGroups(issues);
        const wrap = document.createElement("div");
        wrap.className = "mini-donut-card";
        addTextElement(wrap, "strong", "mini-donut-title", item.name || "Repository");
        const donut = document.createElement("div");
        donut.className = "donut-chart mini-donut";
        const total = issues.length;
        let currentDegree = 0;
        const segments = [];
        for (const group of groups) {
            const degrees = total ? (group.count / total) * 360 : 0;
            if (degrees > 0) {
                segments.push(`${group.color} ${currentDegree}deg ${currentDegree + degrees}deg`);
                currentDegree += degrees;
            }
        }
        donut.style.background = `conic-gradient(${segments.join(", ") || `${COLORS.neutral} 0deg 360deg`})`;
        const hole = document.createElement("div");
        hole.className = "donut-hole";
        addTextElement(hole, "strong", "", String(total));
        addTextElement(hole, "span", "", "issues");
        donut.appendChild(hole);
        wrap.appendChild(donut);
        container.appendChild(wrap);
    }
}

function renderIssues(issueData) {
    currentIssues = Array.isArray(issueData?.issues)
        ? issueData.issues
        : [];
    displayIssues();
}

function displayIssues() {
    const container = document.querySelector("#issues-list");
    const note = document.querySelector("#issue-count-note");
    const scrollButton = document.querySelector("#issue-scroll-button");
    const search = (issueSearch.value || "").trim().toLowerCase();
    const sort = issueSort.value;

    container.replaceChildren();

    const filtered = currentIssues.filter((issue) =>
        String(issue?.title || "").toLowerCase().includes(search)
    );

    filtered.sort((a, b) => {
        if (sort === "title") {
            return String(a?.title || "").localeCompare(
                String(b?.title || "")
            );
        }
        return (Number(b?.score) || 0) - (Number(a?.score) || 0);
    });

    if (!filtered.length) {
        addTextElement(
            container,
            "p",
            "muted",
            currentIssues.length
                ? "No issues match your search. Try another term."
                : "No issues were available to rank for this repository."
        );
        note.textContent =
            `Showing 0 of ${currentIssues.length} retrieved issues.`;
        scrollButton.disabled = true;
        return;
    }

    filtered.forEach((issue, index) => {
        const card = document.createElement("article");
        card.className = "issue-card";
        card.style.animationDelay = `${Math.min(index * 35, 250)}ms`;

        if (issue.url && /^https:\/\/github\.com\//i.test(issue.url)) {
            card.dataset.githubIssue = issue.url;
            card.title = "Open this issue on GitHub";
            card.tabIndex = 0;
            card.setAttribute("role", "link");
            card.setAttribute("aria-label", `Open GitHub issue: ${issue.title || "Untitled issue"}`);
            card.addEventListener("click", (event) => {
                if (event.target.closest("a, button, input, select, textarea")) return;
                openGithubUrl(issue.url);
            });
            card.addEventListener("keydown", (event) => {
                if ((event.key === "Enter" || event.key === " ") && !event.target.closest("a, button, input, select, textarea")) {
                    event.preventDefault();
                    openGithubUrl(issue.url);
                }
            });
        }

        if (issue.url) {
            addSafeLink(
                card,
                issue.title || "Untitled issue",
                issue.url,
                "issue-title"
            );
        } else {
            addTextElement(
                card,
                "p",
                "issue-title",
                issue.title || "Untitled issue"
            );
        }

        const meta = document.createElement("div");
        meta.className = "issue-meta";
        for (const label of getIssueLabels(issue).slice(0, 4)) {
            addTextElement(meta, "span", "tag", label);
        }
        addTextElement(
            meta,
            "span",
            "score",
            `Score: ${Number(issue.score) || 0}`
        );
        card.appendChild(meta);

        addTextElement(
            card,
            "p",
            "issue-estimate",
            issue.difficulty_estimate || "Review the issue manually."
        );

        if (Array.isArray(issue.reasons) && issue.reasons.length) {
            const list = document.createElement("ul");
            list.className = "issue-reasons";
            for (const reason of issue.reasons) {
                addTextElement(list, "li", "", reason);
            }
            card.appendChild(list);
        }

        container.appendChild(card);
    });

    note.textContent =
        `Showing ${filtered.length} of ${currentIssues.length} retrieved issues.`;
    scrollButton.disabled = filtered.length < 4;
    scrollButton.innerHTML = `Scroll issues <span aria-hidden="true">↓</span>`;
}

function renderBriefing(markdown, target = document.querySelector("#briefing")) {
    target.replaceChildren();
    if (typeof markdown !== "string" || !markdown.trim()) {
        addTextElement(target, "p", "", "No AI briefing was returned.");
        return;
    }

    let currentList = null;
    let currentListType = null;

    function closeList() {
        currentList = null;
        currentListType = null;
    }

    function appendInline(parent, text) {
        const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
        let lastIndex = 0;
        let match;

        while ((match = pattern.exec(text)) !== null) {
            parent.appendChild(
                document.createTextNode(text.slice(lastIndex, match.index))
            );
            const token = match[0];
            if (token.startsWith("**")) {
                const strong = document.createElement("strong");
                strong.textContent = token.slice(2, -2);
                parent.appendChild(strong);
            } else {
                const code = document.createElement("code");
                code.textContent = token.slice(1, -1);
                parent.appendChild(code);
            }
            lastIndex = pattern.lastIndex;
        }

        parent.appendChild(
            document.createTextNode(text.slice(lastIndex))
        );
    }

    for (const rawLine of markdown.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) {
            closeList();
            continue;
        }

        const heading = line.match(/^(#{1,3})\s+(.+)$/);
        const boldHeading = line.match(/^\*\*([^*]+)\*\*$/);
        const bullet = line.match(/^[-*]\s+(.+)$/);
        const numbered = line.match(/^\d+[.)]\s+(.+)$/);

        if (heading || boldHeading) {
            closeList();
            const level = heading ? heading[1].length : 3;
            const element = document.createElement(`h${level + 1}`);
            appendInline(
                element,
                heading ? heading[2] : boldHeading[1]
            );
            target.appendChild(element);
            continue;
        }

        if (bullet || numbered) {
            const listType = bullet ? "ul" : "ol";
            if (currentListType !== listType) {
                closeList();
                currentList = document.createElement(listType);
                target.appendChild(currentList);
                currentListType = listType;
            }
            const item = document.createElement("li");
            appendInline(item, (bullet || numbered)[1]);
            currentList.appendChild(item);
            continue;
        }

        closeList();
        const paragraph = document.createElement("p");
        appendInline(paragraph, line);
        target.appendChild(paragraph);
    }
    closeList();
}

async function requestJson(path, options = {}) {
    const response = await fetch(path, {
        credentials: "same-origin",
        ...options,
        headers: {
            ...(options.headers || {}),
        },
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(
            typeof data.detail === "string"
                ? data.detail
                : `Request failed (${response.status}).`
        );
    }

    return data;
}

async function fetchJson(endpoint, url) {
    const query = new URLSearchParams({ url });
    return requestJson(
        `${endpoint}?${query.toString()}`,
        { method: "GET" }
    );
}

async function establishSession() {
    await requestJson("/api/session", { method: "GET" });
}

function renderSnapshot(snapshot) {
    const repository = snapshot?.repository;
    if (!repository || !snapshot?.issueData) {
        throw new Error(
            "This saved snapshot is incomplete and cannot be displayed."
        );
    }

    currentSnapshot = snapshot;
    document.querySelector("#repo-name").textContent =
        repository.name || "Repository overview";
    document.querySelector("#repo-description").textContent =
        repository.description || "No repository description has been provided.";

    const repoLink = document.querySelector("#repo-link");
    repoLink.href = repository.url || "#";

    renderStats(repository);
    renderAnalysisOverview(repository, snapshot.health || {}, snapshot.issueData);
    renderSignals(snapshot.health || {});
    renderAnalytics(snapshot.issueData);
    renderIssues(snapshot.issueData);
    renderBriefing(snapshot.briefData?.briefing);

    currentSnapshot = snapshot;
    results.hidden = false;
    saveButton.disabled = false;
}

async function saveCurrentSnapshot(showMessage = true) {
    if (!currentSnapshot) {
        if (showMessage) {
            setStatus("Analyse a repository before saving a snapshot.", "error");
        }
        return false;
    }

    saveButton.disabled = true;
    const previousText = saveButton.textContent;
    saveButton.textContent = "Saving...";

    try {
        await establishSession();

        const repository = currentSnapshot.repository;
        const data = await requestJson("/api/history", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                repository: repository.name,
                url: repository.url,
                snapshot: currentSnapshot,
            }),
        });

        if (showMessage) {
            setStatus(`Snapshot saved for ${data.analysis?.repository || repository.name}.`);
        }
        await loadHistory();
        return true;
    } catch (error) {
        if (showMessage) {
            setStatus(`Analysis is still available, but saving failed: ${error.message}`, "error");
        }
        return false;
    } finally {
        saveButton.disabled = false;
        saveButton.textContent = previousText.includes("Save snapshot")
            ? previousText
            : "💾 Save snapshot";
    }
}

async function loadHistory({ refresh = false } = {}) {
    if (historyLoadingPromise && !refresh) {
        return historyLoadingPromise;
    }

    historyLoadingPromise = (async () => {
        try {
            await establishSession();
            const data = await requestJson("/api/history?limit=100", {
                method: "GET",
            });

            historyEntries = uniqueHistoryEntries(
                Array.isArray(data.history) ? data.history : []
            );
            selectedHistoryIds = new Set(
                [...selectedHistoryIds].filter((id) =>
                    historyEntries.some(
                        (entry) => String(entry.id) === String(id)
                    )
                )
            );

            renderHistory();
            populateCompareSelectors();
        } catch (error) {
            document.querySelector("#history-description").textContent =
                `Could not load history: ${error.message}`;
            document.querySelector("#history-list").replaceChildren();
            document.querySelector("#history-empty").hidden = false;
            document.querySelector("#history-count").textContent = "!";
        } finally {
            historyLoadingPromise = null;
        }
    })();

    return historyLoadingPromise;
}

function renderHistory() {
    const list = document.querySelector("#history-list");
    const empty = document.querySelector("#history-empty");
    list.replaceChildren();

    document.querySelector("#history-count").textContent =
        String(historyEntries.length);
    document.querySelector("#history-description").textContent =
        historyEntries.length
            ? `${historyEntries.length} repositor${historyEntries.length === 1 ? "y" : "ies"} saved. Re-analysing updates the same entry.`
            : "No analyses saved yet.";

    empty.hidden = historyEntries.length > 0;

    for (const entry of historyEntries) {
        const row = document.createElement("article");
        row.className = "history-row";

        const identity = document.createElement("div");
        identity.className = "history-identity";

        const mark = addTextElement(
            identity,
            "div",
            "history-avatar",
            String(entry.repository || "?").charAt(0).toUpperCase()
        );
        mark.setAttribute("aria-hidden", "true");

        const copy = document.createElement("div");
        copy.className = "history-copy";
        addTextElement(copy, "h3", "history-repository", entry.repository || "Unknown repository");
        addTextElement(copy, "p", "history-date", `Updated ${formatDate(entry.created_at)}`);
        addSafeLink(copy, "Open on GitHub ↗", entry.url, "text-link");
        identity.appendChild(copy);
        row.appendChild(identity);

        const actions = document.createElement("div");
        actions.className = "history-card-actions";

        const checkboxLabel = document.createElement("label");
        checkboxLabel.className = "history-select-label";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selectedHistoryIds.has(String(entry.id));
        checkbox.setAttribute("aria-label", `Select ${entry.repository} for comparison`);
        checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
                if (selectedHistoryIds.size >= 2) {
                    checkbox.checked = false;
                    setHistoryNotice("Select only two repositories for comparison.");
                    return;
                }
                selectedHistoryIds.add(String(entry.id));
            } else {
                selectedHistoryIds.delete(String(entry.id));
            }
        });
        checkboxLabel.appendChild(checkbox);
        addTextElement(checkboxLabel, "span", "", "Compare");
        actions.appendChild(checkboxLabel);

        const viewButton = addTextElement(actions, "button", "primary-button", "Open");
        viewButton.type = "button";
        viewButton.addEventListener("click", () => viewHistoryEntry(entry.id));

        const deleteButton = addTextElement(actions, "button", "outline-button", "Remove");
        deleteButton.type = "button";
        deleteButton.addEventListener("click", () => deleteHistoryEntry(entry.id));

        row.appendChild(actions);
        list.appendChild(row);
    }
}

function setHistoryNotice(message) {
    document.querySelector("#history-description").textContent = message;
}

async function viewHistoryEntry(id) {
    try {
        const entry = await requestJson(
            `/api/history/${encodeURIComponent(id)}`,
            { method: "GET" }
        );
        renderSnapshot(entry.snapshot);
        urlInput.value = entry.url || "";
        showView("analyse");
        setStatus(`Loaded saved snapshot for ${entry.repository}.`);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
        setHistoryNotice(`Could not open snapshot: ${error.message}`);
    }
}

async function deleteHistoryEntry(id) {
    const entry = historyEntries.find(
        (item) => String(item.id) === String(id)
    );
    if (!entry) return;

    if (!window.confirm(`Delete the saved snapshot for ${entry.repository}?`)) return;

    try {
        await requestJson(
            `/api/history/${encodeURIComponent(id)}`,
            { method: "DELETE" }
        );
        selectedHistoryIds.delete(String(id));
        await loadHistory();
    } catch (error) {
        setHistoryNotice(`Could not delete snapshot: ${error.message}`);
    }
}

async function clearHistory() {
    if (!historyEntries.length) {
        setHistoryNotice("There are no saved snapshots to clear.");
        return;
    }

    const confirmed = window.confirm(
        `Delete all ${historyEntries.length} saved snapshots from this browser session? This cannot be undone.`
    );
    if (!confirmed) return;

    try {
        for (const entry of [...historyEntries]) {
            await requestJson(
                `/api/history/${encodeURIComponent(entry.id)}`,
                { method: "DELETE" }
            );
        }
        selectedHistoryIds.clear();
        await loadHistory();
    } catch (error) {
        await loadHistory();
        setHistoryNotice(`Some snapshots may remain. ${error.message}`);
    }
}

function showView(viewName) {
    const safeView = ["analyse", "history", "compare"].includes(viewName)
        ? viewName
        : "analyse";

    const drawerOpen = safeView === "history" || safeView === "compare";
    const backdrop = document.querySelector("#drawer-backdrop");
    const analyseView = document.querySelector("#analyse-view");

    if (analyseView) {
        analyseView.hidden = false;
        analyseView.classList.add("active");
    }

    for (const [name, id] of [["history", "history-view"], ["compare", "compare-view"]]) {
        const view = document.getElementById(id);
        if (!view) continue;
        const active = drawerOpen && safeView === name;
        view.hidden = false;
        view.classList.toggle("drawer-open", active);
        view.classList.toggle("active", active);
        view.setAttribute("aria-hidden", active ? "false" : "true");
        view.toggleAttribute("inert", !active);
    }

    document.body.classList.toggle("drawer-is-open", drawerOpen);
    if (backdrop) backdrop.hidden = !drawerOpen;

    document.querySelectorAll(".nav-link[data-view]").forEach((button) => {
        button.classList.toggle("active", button.dataset.view === safeView);
        button.setAttribute("aria-expanded", String(button.dataset.view === safeView && drawerOpen));
    });

    if (safeView === "history") {
        renderHistory();
        loadHistory({ refresh: true });
        document.querySelector("#history-view .drawer-close-button")?.focus({ preventScroll: true });
    }
    if (safeView === "compare") {
        populateCompareSelectors();
        loadHistory({ refresh: true });
        populateCompareSelectors();
        const hasResults = document.querySelector("#comparison-results")?.dataset.hasResults === "true";
        document.querySelector("#comparison-empty").hidden = hasResults;
        document.querySelector("#compare-view .drawer-close-button")?.focus({ preventScroll: true });
    }
}

function populateCompareSelectors() {
    for (const id of ["compare-first", "compare-second"]) {
        const select = document.getElementById(id);
        const previous = select.value;
        select.replaceChildren();

        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Choose a saved snapshot";
        select.appendChild(placeholder);

        for (const entry of historyEntries) {
            const option = document.createElement("option");
            option.value = String(entry.id);
            option.textContent = `${entry.repository} • ${formatDate(entry.created_at)}`;
            select.appendChild(option);
        }

        if (historyEntries.some((entry) => String(entry.id) === previous)) {
            select.value = previous;
        }
    }

    document.querySelector("#compare-selected-button").disabled = historyEntries.length < 2;
    document.querySelector("#run-compare-button").disabled = historyEntries.length < 2;
}

function addMetricComparison(container, title, firstValue, secondValue) {
    const row = document.createElement("div");
    row.className = "comparison-metric";
    addTextElement(row, "div", "comparison-metric-title", title);

    const values = document.createElement("div");
    values.className = "comparison-metric-values";

    const first = addTextElement(values, "span", "comparison-value", formatNumber(firstValue));
    const second = addTextElement(values, "span", "comparison-value", formatNumber(secondValue));

    first.title = "First repository";
    second.title = "Second repository";
    row.appendChild(values);

    const max = Math.max(Number(firstValue) || 0, Number(secondValue) || 0, 1);

    for (const [index, value] of [firstValue, secondValue].entries()) {
        const track = document.createElement("div");
        track.className = "comparison-track";

        const fill = document.createElement("div");
        fill.className = index === 0
            ? "comparison-fill comparison-fill-first"
            : "comparison-fill comparison-fill-second";

        const numericValue = Number(value);
        fill.style.width = Number.isFinite(numericValue) && numericValue >= 0
            ? `${(numericValue / max) * 100}%`
            : "0%";

        track.appendChild(fill);
        row.appendChild(track);
    }

    container.appendChild(row);
}

function snapshotIssueCounts(snapshot) {
    const issues = Array.isArray(snapshot?.issueData?.issues)
        ? snapshot.issueData.issues
        : [];
    return {
        analysed: issues.length,
        labelled: issues.filter((issue) => getIssueLabels(issue).length > 0).length,
        beginner: issues.filter((issue) => getIssueLabels(issue).some(isBeginnerLabel)).length,
    };
}

function renderHealthMeter(container, score, labelText) {
    const wrapper = document.createElement("div");
    wrapper.className = "health-meter-wrapper";
    
    const label = document.createElement("div");
    label.textContent = labelText;
    label.className = "health-meter-label";
    
    const track = document.createElement("div");
    track.className = "health-meter-track";
    
    const fill = document.createElement("div");
    fill.className = "health-meter-fill";
    
    const numericScore = Math.max(0, Math.min(100, Number(score) || 0));
    fill.style.width = `${numericScore}%`;
    
    if (numericScore > 75) fill.style.backgroundColor = "#5ce1bb";
    else if (numericScore > 40) fill.style.backgroundColor = "#ffb86c";
    else fill.style.backgroundColor = "#ff5555";
    
    track.appendChild(fill);
    wrapper.appendChild(label);
    wrapper.appendChild(track);
    container.appendChild(wrapper);
}

async function runComparison() {
    const firstId = document.querySelector("#compare-first").value;
    const secondId = document.querySelector("#compare-second").value;
    const status = document.querySelector("#compare-status");
    const resultSection = document.querySelector("#comparison-results");
    const empty = document.querySelector("#comparison-empty");
    const button = document.querySelector("#run-compare-button");

    if (!firstId || !secondId) {
        status.textContent = "Choose two saved snapshots first.";
        return;
    }
    if (firstId === secondId) {
        status.textContent = "Choose two different saved snapshots.";
        return;
    }

    button.disabled = true;
    status.textContent = "Loading saved snapshots...";

    try {
        const [first, second] = await Promise.all([
            requestJson(`/api/history/${encodeURIComponent(firstId)}`, { method: "GET" }),
            requestJson(`/api/history/${encodeURIComponent(secondId)}`, { method: "GET" }),
        ]);

        const a = first.snapshot?.repository;
        const b = second.snapshot?.repository;

        if (!a || !b) {
            throw new Error("One of the snapshots is missing repository metrics.");
        }

        const summary = document.querySelector("#comparison-summary");
        summary.replaceChildren();

        for (const item of [
            { label: "First repository", value: first.repository, date: first.created_at, url: first.url },
            { label: "Second repository", value: second.repository, date: second.created_at, url: second.url },
        ]) {
            const card = document.createElement("article");
            card.className = "comparison-summary-card";
            addTextElement(card, "span", "comparison-summary-label", item.label);
            addTextElement(card, "h3", "", item.value);
            addTextElement(card, "p", "muted", formatDate(item.date));
            addSafeLink(card, "Open repository ↗", item.url, "text-link");
            summary.appendChild(card);
        }

        const metricChart = document.querySelector("#comparison-metrics-chart");
        metricChart.replaceChildren();
        addMetricComparison(metricChart, "Stars", a.stars, b.stars);
        addMetricComparison(metricChart, "Forks", a.forks, b.forks);
        addMetricComparison(metricChart, "Open issues", a.open_issues, b.open_issues);

        const countsA = snapshotIssueCounts(first.snapshot);
        const countsB = snapshotIssueCounts(second.snapshot);

        const issueChart = document.querySelector("#comparison-issues-chart");
        issueChart.replaceChildren();
        addMetricComparison(issueChart, "Issues analysed", countsA.analysed, countsB.analysed);
        addMetricComparison(issueChart, "Issues with labels", countsA.labelled, countsB.labelled);
        addMetricComparison(issueChart, "Beginner signals", countsA.beginner, countsB.beginner);

        const scoreA = countsA.analysed > 0 ? Math.round((countsA.beginner / countsA.analysed) * 100) : 0;
        const scoreB = countsB.analysed > 0 ? Math.round((countsB.beginner / countsB.analysed) * 100) : 0;
        
        renderHealthMeter(issueChart, scoreA, `Beginner ratio (${a.name})`);
        renderHealthMeter(issueChart, scoreB, `Beginner ratio (${b.name})`);

        renderComparisonRadar(
            document.querySelector("#comparison-radar"),
            a,
            b,
            countsA,
            countsB
        );
        renderComparisonPriority(
            document.querySelector("#comparison-priority-charts"),
            first.snapshot,
            second.snapshot,
            a.name,
            b.name
        );

        resultSection.hidden = false;
        resultSection.dataset.hasResults = "true";
        empty.hidden = true;
        status.textContent = "Comparison metrics ready. Requesting AI comparison briefing...";

        const ai = document.querySelector("#comparison-ai");
        renderBriefing("Requesting AI comparison briefing...", ai);

        try {
            const compareData = await requestJson("/api/repository/compare-brief", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    first_id: Number(firstId),
                    second_id: Number(secondId),
                }),
            });
            renderBriefing(compareData.comparison_brief || "No AI comparison was returned.", ai);
        } catch (aiError) {
            renderBriefing(`AI comparison unavailable: ${aiError.message}`, ai);
        }

        status.textContent = "Comparison ready. Values come from the two saved snapshots.";
    } catch (error) {
        status.textContent = error.message || "Could not compare those snapshots.";
    } finally {
        button.disabled = false;
    }
}

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const repositoryUrl = urlInput.value.trim();
    if (!repositoryUrl) {
        setStatus("Enter a public GitHub repository URL.", "error");
        return;
    }

    analyzeButton.disabled = true;
    buttonLabel.textContent = "Analysing...";
    saveButton.disabled = true;
    results.hidden = true;
    clearResults();
    currentSnapshot = null;
    issueSearch.value = "";
    issueSort.value = "score";

    setStatus("Retrieving GitHub evidence and preparing your AI briefing...", "loading");

    try {
        await establishSession();
        const [repository, health, issueData, briefData] = await Promise.all([
            fetchJson("/api/repository", repositoryUrl),
            fetchJson("/api/repository/health", repositoryUrl),
            fetchJson("/api/repository/issues", repositoryUrl),
            fetchJson("/api/repository/brief", repositoryUrl),
        ]);

        const snapshot = { repository, health, issueData, briefData };
        renderSnapshot(snapshot);
        setStatus(`Analysis complete for ${repository.name || "this repository"}. Saving snapshot...`, "loading");

        const saved = await saveCurrentSnapshot(false);
        if (saved) {
            setStatus(`Analysis complete and snapshot saved for ${repository.name || "this repository"}.`);
        } else {
            setStatus(`Analysis complete for ${repository.name || "this repository"}, but automatic history saving failed. Your results are still available.`, "error");
        }

        results.scrollIntoView({
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
            block: "start",
        });
    } catch (error) {
        setStatus(error.message || "Something went wrong. Please try again.", "error");
    } finally {
        analyzeButton.disabled = false;
        buttonLabel.textContent = "Analyse";
        saveButton.disabled = !currentSnapshot;
    }
});

saveButton.addEventListener("click", () => {
    saveCurrentSnapshot(true);
});

issueSearch.addEventListener("input", displayIssues);
issueSort.addEventListener("change", displayIssues);
document.querySelector("#issue-scroll-button").addEventListener("click", () => {
    const issueList = document.querySelector("#issues-list");
    const atBottom =
        issueList.scrollTop + issueList.clientHeight >= issueList.scrollHeight - 8;

    issueList.scrollTo({
        top: atBottom ? 0 : issueList.scrollHeight,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
    });

    const button = document.querySelector("#issue-scroll-button");
    button.innerHTML = atBottom
        ? `Scroll issues <span aria-hidden="true">↓</span>`
        : `Back to top <span aria-hidden="true">↑</span>`;
});

document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", (event) => {
        if (button.tagName === "A") event.preventDefault();
        showView(button.dataset.view);
    });
});

document.querySelector("#compare-selected-button").addEventListener("click", () => {
    const selected = [...selectedHistoryIds];
    if (selected.length !== 2) {
        setHistoryNotice("Select exactly two snapshots using the Compare checkboxes.");
        return;
    }
    showView("compare");
    document.querySelector("#compare-first").value = selected[0];
    document.querySelector("#compare-second").value = selected[1];
    runComparison();
});

document.querySelector("#clear-history-button").addEventListener("click", clearHistory);
document.querySelector("#run-compare-button").addEventListener("click", runComparison);

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.classList.contains("drawer-is-open")) {
        showView("analyse");
    }
});

let scrollAnimationTimer;
let scrollFramePending = false;
window.addEventListener("scroll", () => {
    document.body.classList.add("is-scrolling");
    if (!scrollFramePending) {
        scrollFramePending = true;
        window.requestAnimationFrame(() => {
            const hero = document.querySelector(".hero");
            if (hero) {
                hero.style.setProperty(
                    "--scroll-shift",
                    `${Math.min(window.scrollY * 0.08, 34)}px`
                );
            }
            scrollFramePending = false;
        });
    }
    window.clearTimeout(scrollAnimationTimer);
    scrollAnimationTimer = window.setTimeout(() => {
        document.body.classList.remove("is-scrolling");
    }, 180);
}, { passive: true });

ensureDrawerChrome();
(async function initialiseApp() {
    try {
        await establishSession();
        await loadHistory();
    } catch (error) {
        document.querySelector("#history-description").textContent =
            `History is currently unavailable: ${error.message}`;
    }
})();