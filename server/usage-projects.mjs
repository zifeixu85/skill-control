import { priceTable } from "./pricing.mjs";
import { collectModelRows, priceRows, recordRow, roundUsd, sumCosts } from "./usage-cost.mjs";

/**
 * Cost per project: the working folder's last path segment as stored in the index (never a
 * full path). Two folders with the same name are one project; sessions and database
 * records without a folder form the `name: null` project (未识别项目). Projects are priced
 * exactly like the agent totals (same rows, buckets and rules, and the agent's own average
 * for "@agent-average" estimates), so the projects of an agent add up to its total.
 */

const TYPES = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"];
const projectName = (value) => (typeof value === "string" && value ? value : null);

/** Per agent (or only `onlyAgent`), per project within the window: { name, sessions, tokens, rows, records }. */
function projectRowsByAgent(index, inWindow, onlyAgent = null) {
  const agents = new Map();
  const project = (agentId, name) => {
    if (!agents.has(agentId)) agents.set(agentId, new Map());
    const projects = agents.get(agentId);
    const key = projectName(name);
    if (!projects.has(key)) projects.set(key, { name: key, sessions: 0, tokens: 0, rows: new Map(), records: [] });
    return projects.get(key);
  };
  for (const entry of Object.values(index.files || {})) {
    if (onlyAgent && entry.a !== onlyAgent) continue;
    const rows = new Map();
    const priced = collectModelRows(rows, entry.m, inWindow);
    let sessions = 0;
    let tokens = 0;
    for (const [day, values] of Object.entries(entry.d || {})) {
      if (!inWindow(day)) continue;
      sessions += values[0];
      tokens += values[5];
    }
    if (!priced && !sessions && !tokens) continue;
    const target = project(entry.a, entry.p);
    target.sessions += sessions;
    target.tokens += tokens;
    for (const [model, list] of rows) {
      const existing = target.rows.get(model);
      if (existing) for (const item of list) existing.push(item);
      else target.rows.set(model, list);
    }
  }
  for (const [agentId, records] of Object.entries(index.records || {})) {
    if (onlyAgent && agentId !== onlyAgent) continue;
    for (const record of Object.values(records)) {
      if (!inWindow(record.d)) continue;
      const target = project(agentId, record.p);
      target.sessions += 1;
      target.tokens += record.t?.[4] || 0;
      target.records.push(recordRow(record));
    }
  }
  return agents;
}

const byCost = (left, right) =>
  right.costUsd - left.costUsd || right.tokens - left.tokens || (left.name === null) - (right.name === null) || String(left.name).localeCompare(String(right.name));

const topModels = (byModel) => byModel.slice(0, 3).map(({ model, name, costUsd }) => ({ model, name, costUsd }));

/** The rows past `limit`, summed so the list reconciles with the total. */
function rest(list, limit) {
  const others = list.slice(limit);
  return {
    count: others.length,
    costUsd: roundUsd(others.reduce((sum, item) => sum + item.costUsd, 0)),
    tokens: others.reduce((sum, item) => sum + item.tokens, 0),
  };
}

/** Priced projects of every agent (or only `agentId`): Map agentId → [{ name, sessions, tokens, priced }]. */
export function costProjects(index, inWindow, costs, { agentId: onlyAgent = null, table = priceTable() } = {}) {
  const result = new Map();
  for (const [agentId, projects] of projectRowsByAgent(index, inWindow, onlyAgent)) {
    // The agent's own average keeps "@agent-average" rows consistent with the agent total.
    const options = costs.has(agentId) ? { table, average: costs.get(agentId).average } : { table };
    result.set(
      agentId,
      [...projects.values()].map((project) => ({ ...project, priced: priceRows(agentId, { rows: project.rows, records: project.records }, options) })),
    );
  }
  return result;
}

/** topProjects / otherProjects of GET /api/usage/agent. */
export function agentProjects(projects = [], limit = 20) {
  const list = projects
    .map(({ name, sessions, tokens, priced }) => ({
      name,
      sessions,
      tokens,
      tokenSplit: Object.fromEntries(TYPES.map((type) => [type, priced.byModel.reduce((sum, row) => sum + row.tokens[type], 0)])),
      costUsd: priced.costUsd,
      costBasis: priced.costBasis,
      unpricedTokens: priced.unpricedTokens,
      topModels: topModels(priced.byModel),
    }))
    .sort(byCost);
  return { topProjects: list.slice(0, limit), otherProjects: rest(list, limit) };
}

/** GET /api/usage/projects: one row per project name across agents. */
export function projectsAcrossAgents(projectsByAgent, costs, limit = 30) {
  const merged = new Map();
  for (const [agentId, projects] of projectsByAgent) {
    for (const { name, sessions, tokens, priced } of projects) {
      const target = merged.get(name) || { name, sessions: 0, tokens: 0, parts: [], agents: [], models: new Map() };
      target.sessions += sessions;
      target.tokens += tokens;
      target.parts.push(priced);
      target.agents.push({ agentId, tokens, costUsd: priced.costUsd });
      for (const row of priced.byModel) {
        const model = target.models.get(row.model) || { model: row.model, name: row.name, costUsd: 0, tokens: 0 };
        model.costUsd += row.costUsd;
        model.tokens += row.tokens.total;
        target.models.set(row.model, model);
      }
      merged.set(name, target);
    }
  }
  const list = [...merged.values()]
    .map(({ parts, models, agents, ...project }) => ({
      ...project,
      ...sumCosts(parts),
      agents: agents.sort((left, right) => right.costUsd - left.costUsd || right.tokens - left.tokens),
      topModels: topModels(
        [...models.values()]
          .map((model) => ({ ...model, costUsd: roundUsd(model.costUsd) }))
          .sort((left, right) => right.costUsd - left.costUsd || right.tokens - left.tokens),
      ),
    }))
    .sort(byCost);
  return { totals: sumCosts([...costs.values()]), projects: list.slice(0, limit), other: rest(list, limit) };
}
