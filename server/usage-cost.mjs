import { costParts, priceFor, priceTable, resolve, resolveFamily } from "./pricing.mjs";

/**
 * Query-time costing of the usage index with the current price table. Every amount is an
 * API-equivalent estimate at the vendors' official prices; subscription use is not an
 * actual expense. Products that report their own cost (Hermes, OpenClaw, QClaw) keep it as
 * `reportedCostUsd`, and it only becomes the estimate when a session has no priced model.
 */

const TYPES = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"];
const BASES = ["official", "estimate", "family", "reported"];
/** Micro-dollar precision: single requests of cheap models cost fractions of a cent. */
export const roundUsd = (value) => Math.round((value || 0) * 1_000_000) / 1_000_000;
const rowTotal = (row) => row[0] + row[1] + row[2] + row[3] + row[4];

/** Per agent within the window: { rows: Map(model → [{ day, bucket, row }]), records: [...] }. */
export function modelRowsByAgent(index, inWindow) {
  const agents = new Map();
  const agent = (agentId) => {
    if (!agents.has(agentId)) agents.set(agentId, { rows: new Map(), records: [], skills: new Map() });
    return agents.get(agentId);
  };
  const collect = (target, byModel) => {
    for (const [model, byDay] of Object.entries(byModel || {})) {
      for (const [day, byBucket] of Object.entries(byDay)) {
        if (!inWindow(day)) continue;
        const list = target.get(model) || [];
        for (const [bucket, row] of Object.entries(byBucket)) list.push({ day, bucket, row });
        target.set(model, list);
      }
    }
  };
  for (const entry of Object.values(index.files || {})) {
    if (!entry.m && !entry.km) continue;
    const target = agent(entry.a);
    collect(target.rows, entry.m);
    for (const [skill, byModel] of Object.entries(entry.km || {})) {
      if (!target.skills.has(skill)) target.skills.set(skill, new Map());
      collect(target.skills.get(skill), byModel);
    }
  }
  for (const [agentId, records] of Object.entries(index.records || {})) {
    for (const record of Object.values(records)) {
      if (!inWindow(record.d)) continue;
      const t = record.t || [];
      agent(agentId).records.push({
        model: record.m || null,
        day: record.d,
        bucket: record.b || "s",
        row: [t[0] || 0, t[1] || 0, t[2] || 0, t[3] || 0, 0, record.n || 0],
        reported: record.rc ?? record.c ?? 0,
      });
    }
  }
  return agents;
}

function accumulator() {
  const models = new Map();
  const typeCost = [0, 0, 0, 0, 0];
  const typeTokens = [0, 0, 0, 0, 0];
  const byDay = new Map();
  return {
    models,
    typeCost,
    typeTokens,
    byDay,
    add(model, resolution, basis, day, row, cost, long = false, countForAverage = false, parts = null) {
      const key = `${model}|${basis}|${resolution.priceAs || ""}`;
      const acc = models.get(key) || { model, resolution, basis, row: [0, 0, 0, 0, 0, 0], costUsd: 0, longTokens: 0 };
      row.forEach((value, index) => {
        acc.row[index] += value;
      });
      acc.costUsd += cost;
      if (long) acc.longTokens += rowTotal(row);
      models.set(key, acc);
      byDay.set(day, (byDay.get(day) || 0) + cost);
      if (countForAverage && parts) {
        parts.forEach((value, index) => {
          typeCost[index] += value;
          typeTokens[index] += row[index];
        });
      }
    },
  };
}

/** Token-weighted unit prices (USD / 1M) of everything already priced, or null. */
function averagePrice(acc) {
  const unit = TYPES.map((type, index) => (acc.typeTokens[index] > 0 ? (acc.typeCost[index] / acc.typeTokens[index]) * 1_000_000 : null));
  if (unit[0] === null || unit[1] === null) return null;
  unit[2] ??= unit[0];
  unit[3] ??= unit[0];
  unit[4] ??= unit[3];
  return Object.fromEntries(TYPES.map((type, index) => [type, unit[index]]));
}

function priceRow(acc, model, resolution, { day, bucket, row }, countForAverage) {
  const price = priceFor(resolution.entry, day, bucket);
  const parts = costParts(row, price);
  acc.add(model, resolution, resolution.basis, day, row, parts.reduce((sum, value) => sum + value, 0), price.long, countForAverage, parts);
}

/**
 * Prices one agent's (or one skill's) rows. `average` is the agent's own average for
 * "@agent-average" estimates; when it is not given it is computed from these rows.
 */
export function priceRows(agentId, { rows = new Map(), records = [] }, { table = priceTable(), average } = {}) {
  const acc = accumulator();
  const deferred = [];
  let reportedCostUsd = 0;
  for (const [model, list] of rows) {
    const resolution = resolve(model, table, { agentId });
    if (resolution.basis === "ignored") continue;
    for (const item of list) {
      if (resolution.average) deferred.push({ model, resolution, item, reported: 0 });
      else if (resolution.entry) priceRow(acc, model, resolution, item, true);
      else acc.add(model, resolution, "unpriced", item.day, item.row, 0);
    }
  }
  for (const record of records) {
    reportedCostUsd += record.reported;
    const model = record.model || "unknown";
    const resolution = record.model ? resolve(record.model, table, { agentId }) : { basis: "unpriced" };
    if (resolution.basis === "ignored") continue;
    if (resolution.average) deferred.push({ model, resolution, item: record, reported: record.reported });
    else if (resolution.entry) priceRow(acc, model, resolution, record, true);
    else if (record.reported > 0) acc.add(model, { basis: "reported" }, "reported", record.day, record.row, record.reported);
    else acc.add(model, resolution, "unpriced", record.day, record.row, 0);
  }
  const unit = average === undefined ? averagePrice(acc) : average;
  for (const { model, resolution, item, reported } of deferred) {
    if (unit) {
      acc.add(model, { ...resolution, unitPrice: unit }, "estimate", item.day, item.row, costParts(item.row, unit).reduce((sum, value) => sum + value, 0));
      continue;
    }
    // Nothing else to average: the id's family, then the product's own figure, then unpriced.
    const family = resolveFamily(model, table);
    if (family.entry) priceRow(acc, model, family, item, false);
    else if (reported > 0) acc.add(model, { basis: "reported" }, "reported", item.day, item.row, reported);
    else acc.add(model, { basis: "unpriced" }, "unpriced", item.day, item.row, 0);
  }
  return { ...summarize(acc), average: unit, reportedCostUsd: records.length ? roundUsd(reportedCostUsd) : null };
}

function publicModel(acc) {
  const { resolution, row } = acc;
  const entry = resolution.entry;
  const total = rowTotal(row);
  return {
    model: acc.model,
    name: acc.basis === "official" ? entry.name : acc.model,
    vendor: entry?.vendor || null,
    basis: acc.basis,
    ...(resolution.priceAs ? { priceAs: resolution.priceAs } : {}),
    ...(resolution.priceRef ? { priceRef: resolution.priceRef } : {}),
    ...(resolution.unitPrice ? { unitPrice: Object.fromEntries(TYPES.map((type) => [type, roundUsd(resolution.unitPrice[type])])) } : {}),
    tokens: { input: row[0], output: row[1], cacheRead: row[2], cacheWrite: row[3], cacheWrite1h: row[4], total },
    requests: row[5],
    costUsd: roundUsd(acc.costUsd),
    longShare: total ? Math.round((acc.longTokens / total) * 1_000) / 1_000 : 0,
  };
}

function summarize(acc) {
  const costBasis = Object.fromEntries(BASES.map((basis) => [basis, 0]));
  let unpricedTokens = 0;
  for (const model of acc.models.values()) {
    if (model.basis === "unpriced") unpricedTokens += rowTotal(model.row);
    else costBasis[model.basis] += model.costUsd;
  }
  const costUsd = BASES.reduce((sum, basis) => sum + costBasis[basis], 0);
  const byModel = [...acc.models.values()]
    .map(publicModel)
    .sort((left, right) => right.costUsd - left.costUsd || right.tokens.total - left.tokens.total || left.model.localeCompare(right.model));
  return {
    costUsd: roundUsd(costUsd),
    costBasis: Object.fromEntries(BASES.map((basis) => [basis, roundUsd(costBasis[basis])])),
    unpricedTokens,
    byModel,
    byDay: acc.byDay,
  };
}

/** Costs per agent and per attributed skill for one window. */
export function costIndex(index, inWindow, table = priceTable()) {
  const agents = new Map();
  for (const [agentId, source] of modelRowsByAgent(index, inWindow)) {
    const priced = priceRows(agentId, source, { table });
    const skills = new Map();
    for (const [skill, rows] of source.skills) skills.set(skill, priceRows(agentId, { rows }, { table, average: priced.average }));
    agents.set(agentId, { ...priced, skills });
  }
  return agents;
}

/** Totals over several priced agents (or skills). */
export function sumCosts(list) {
  const costBasis = Object.fromEntries(BASES.map((basis) => [basis, 0]));
  let unpricedTokens = 0;
  for (const item of list) {
    for (const basis of BASES) costBasis[basis] += item.costBasis[basis];
    unpricedTokens += item.unpricedTokens;
  }
  return {
    costUsd: roundUsd(BASES.reduce((sum, basis) => sum + costBasis[basis], 0)),
    costBasis: Object.fromEntries(BASES.map((basis) => [basis, roundUsd(costBasis[basis])])),
    unpricedTokens,
  };
}

/** GET /api/usage/models: every model across agents, with the agents that used it. */
export function modelsAcrossAgents(costs) {
  const merged = new Map();
  for (const [agentId, priced] of costs) {
    for (const row of priced.byModel) {
      const key = `${row.model}|${row.basis}|${row.priceAs || ""}`;
      const target = merged.get(key) || { ...row, tokens: { ...row.tokens }, costUsd: 0, requests: 0, agents: [], longTokens: 0 };
      if (merged.has(key)) for (const field of Object.keys(target.tokens)) target.tokens[field] += row.tokens[field];
      target.costUsd += row.costUsd;
      target.requests += row.requests;
      target.longTokens += row.longShare * row.tokens.total;
      target.agents.push({ agentId, tokens: row.tokens.total, costUsd: row.costUsd });
      merged.set(key, target);
    }
  }
  return [...merged.values()]
    .map(({ longTokens, ...row }) => ({
      ...row,
      costUsd: roundUsd(row.costUsd),
      longShare: row.tokens.total ? Math.round((longTokens / row.tokens.total) * 1_000) / 1_000 : 0,
      agents: row.agents.sort((left, right) => right.costUsd - left.costUsd || right.tokens - left.tokens),
    }))
    .sort((left, right) => right.costUsd - left.costUsd || right.tokens.total - left.tokens.total || left.model.localeCompare(right.model));
}
