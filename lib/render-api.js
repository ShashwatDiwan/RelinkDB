const API_BASE = "https://api.render.com/v1";

function fail(msg) {
  throw new Error(msg);
}

async function renderRequest(apiKey, pathname, options = {}) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    fail(
      `Render API error ${res.status} on ${pathname}:\n${JSON.stringify(json, null, 2)}\n` +
        `Double check your RENDER_API_KEY and IDs.`
    );
  }
  return json;
}

async function findPostgresIdByName(apiKey, name, onLog = console.log) {
  onLog(`→ Looking up Postgres instance named "${name}"...`);
  const list = await renderRequest(apiKey, `/postgres?limit=100`);
  const items = Array.isArray(list) ? list : list.items || [];
  const normalized = items.map((it) => it.postgres || it);
  const matches = normalized.filter((db) => db.name === name);

  if (matches.length === 0) {
    const available = normalized.map((db) => `  - ${db.name} (${db.id})`).join("\n");
    fail(
      `No Postgres instance named "${name}" found.` +
        (available ? `\nAvailable Postgres instances in this account:\n${available}` : "")
    );
  }

  matches.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const chosen = matches[0];
  onLog(`  ✓ Found ${chosen.name} (${chosen.id})`);
  return chosen.id;
}

async function findPostgresByName(apiKey, name) {
  const list = await renderRequest(apiKey, `/postgres?limit=100`);
  const items = Array.isArray(list) ? list : list.items || [];
  const normalized = items.map((it) => it.postgres || it);
  const matches = normalized.filter((db) => db.name === name);
  matches.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return matches[0] || null;
}

async function getConnectionString(apiKey, postgresId, onLog = console.log) {
  onLog("→ Fetching connection info...");
  const info = await renderRequest(apiKey, `/postgres/${postgresId}/connection-info`);

  const candidate =
    info.externalConnectionString ||
    info.externalUrl ||
    info.connectionInfo?.externalConnectionString ||
    (info.psqlCommand && info.psqlCommand.match(/postgres(?:ql)?:\/\/\S+/)?.[0]);

  if (!candidate) {
    fail(
      "Couldn't auto-extract the connection string. Raw connection-info response:\n" +
        `${JSON.stringify(info, null, 2)}\n` +
        "Find the external connection URL field and update the extraction logic in lib/render-api.js."
    );
  }
  onLog("  ✓ Got external connection string");
  return candidate;
}

function isPostgresAvailable(db) {
  if (!db) return false;
  const status = (db.status || db.state || db.postgresStatus || "").toString().toLowerCase();
  if (!status) return true;
  return (
    status === "available" ||
    status === "available_and_ready" ||
    status === "ready" ||
    status === "active" ||
    status === "running" ||
    status.includes("available")
  );
}

module.exports = {
  fail,
  renderRequest,
  findPostgresIdByName,
  findPostgresByName,
  getConnectionString,
  isPostgresAvailable,
};
