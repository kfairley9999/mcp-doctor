const config = document.querySelector("#config");
const client = document.querySelector("#client");
const check = document.querySelector("#check");
const example = document.querySelector("#example");
const status = document.querySelector("#status");
const empty = document.querySelector("#empty");
const output = document.querySelector("#output");
const summary = document.querySelector("#summary");
const diagnostics = document.querySelector("#diagnostics");
const conversions = document.querySelector("#conversions");
const formError = document.querySelector("#form-error");
const matrixHead = document.querySelector("#matrix thead");
const matrixBody = document.querySelector("#matrix tbody");

const EXAMPLE = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["@modelcontextprotocol/server-filesystem", "./data"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_exampleExampleExampleExample12" }
    },
    "remote": {
      "serverUrl": "http://example.com/mcp",
      "headers": { "Authorization": "Bearer \${env:TOKEN}" }
    }
  }
}
`;

const FIELDS = [
  ["stdio", "stdio"],
  ["http", "http"],
  ["sse", "sse"],
  ["ws", "ws"],
  ["command", "command"],
  ["env", "env"],
  ["cwd", "cwd"],
  ["headers", "headers"],
  ["timeoutMs", "timeout"],
  ["envFile", "envFile"],
];

example.addEventListener("click", () => {
  config.value = EXAMPLE;
  client.value = "claude-desktop";
  formError.hidden = true;
});

check.addEventListener("click", () => {
  void run();
});

config.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    void run();
  }
});

void loadMeta();

async function loadMeta() {
  try {
    const response = await fetch("/api/meta");
    if (!response.ok) throw new Error(`meta ${response.status}`);
    const meta = await response.json();
    for (const item of meta.clients) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      client.append(option);
    }
    renderMatrix(meta.clients);
  } catch {
    document.querySelector("#matrix-note").textContent = "The field matrix could not be loaded.";
  }
}

function renderMatrix(clients) {
  const head = document.createElement("tr");
  head.append(cell("th", "Client"));
  for (const [, label] of FIELDS) head.append(cell("th", label));
  head.append(cell("th", "interpolation"));
  matrixHead.append(head);
  for (const item of clients) {
    const row = document.createElement("tr");
    const name = document.createElement("th");
    name.textContent = item.label;
    row.append(name);
    for (const [key] of FIELDS) {
      const yes = Boolean(item.support[key]);
      const td = cell("td", yes ? "yes" : "—");
      td.className = yes ? "yes" : "no";
      row.append(td);
    }
    row.append(cell("td", item.interpolation));
    matrixBody.append(row);
  }
}

function cell(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

async function run() {
  formError.hidden = true;
  if (!config.value.trim()) {
    formError.hidden = false;
    formError.textContent = "Paste a config first.";
    return;
  }
  check.disabled = true;
  status.className = "status idle";
  status.textContent = "Checking in this request…";
  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: config.value, client: client.value || undefined }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    render(payload);
  } catch (error) {
    status.className = "status bad";
    status.textContent = "Could not check";
    formError.hidden = false;
    formError.textContent = error instanceof Error ? error.message : "Request failed.";
    empty.hidden = false;
    output.hidden = true;
  } finally {
    check.disabled = false;
  }
}

function render(payload) {
  empty.hidden = true;
  output.hidden = false;
  const errors = [
    ...payload.schemaErrors,
    ...payload.parseDiagnostics.filter((item) => item.severity === "error"),
    ...payload.lint.filter((item) => item.severity === "error"),
  ];
  status.className = errors.length === 0 && payload.valid ? "status ok" : "status bad";
  status.textContent = payload.valid ? `Valid ${payload.client}` : `Problems in ${payload.client}`;
  summary.replaceChildren(
    pill(payload.assumed ? "client guessed" : payload.client),
    pill(`${payload.lint.length} lint`),
    pill(`${payload.schemaErrors.length} schema`),
  );
  const items = [
    ...payload.parseDiagnostics,
    ...payload.schemaErrors.map((error) => ({
      severity: "error",
      code: "schema",
      message: `${error.path} ${error.message}`,
    })),
    ...payload.lint,
  ];
  diagnostics.replaceChildren();
  if (items.length === 0) {
    const li = document.createElement("li");
    li.textContent =
      "No schema errors and no lint findings. Environment rules (PATH, nvm, missing variables) are not run here.";
    diagnostics.append(li);
  }
  for (const item of items) {
    const li = document.createElement("li");
    li.className = item.severity || "error";
    const kicker = document.createElement("p");
    kicker.className = "kicker";
    kicker.textContent = `${item.severity || "error"} · ${item.code}${item.server ? ` · ${item.server}` : ""}`;
    const message = document.createElement("p");
    message.textContent = item.message;
    li.append(kicker, message);
    if (item.suggestion) {
      const fix = document.createElement("p");
      fix.className = "fix";
      fix.textContent = `Fix: ${item.suggestion}`;
      li.append(fix);
    }
    diagnostics.append(li);
  }
  conversions.replaceChildren();
  for (const item of payload.conversions) {
    if (item.client === payload.client) continue;
    const details = document.createElement("details");
    const summaryEl = document.createElement("summary");
    const drops = item.dropped.length;
    summaryEl.textContent = `${item.client}${drops ? ` · ${drops} not carried` : ""}`;
    const pre = document.createElement("pre");
    pre.textContent = item.output;
    details.append(summaryEl, pre);
    if (item.rewritten.length || item.dropped.length) {
      const note = document.createElement("p");
      note.className = "note";
      note.textContent = [...item.rewritten, ...item.dropped]
        .map((entry) => `${entry.field}: ${entry.reason}`)
        .join(" ");
      details.append(note);
    }
    conversions.append(details);
  }
}

function pill(text) {
  const node = document.createElement("span");
  node.className = "pill";
  node.textContent = text;
  return node;
}
