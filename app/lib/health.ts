import {
  asArray,
  asNumber,
  asOptionalString,
  asRecord,
  asString,
  pick,
} from "./parse";

export type SeverityLevel = "high" | "medium" | "low" | "info";

export interface HealthFinding {
  id: string;
  severity: SeverityLevel;
  rawSeverity: string;
  category: string;
  title: string;
  detail: string;
  agentId: string | null;
  skillName: string | null;
  path: string | null;
  fix: { kind: string; label: string } | null;
}

export interface HealthReport {
  generatedAt: string | null;
  counts: Record<string, number>;
  findings: HealthFinding[];
}

export interface SeverityGroup {
  severity: SeverityLevel;
  label: string;
  categories: { category: string; label: string; findings: HealthFinding[] }[];
  total: number;
}

const SEVERITY_ALIASES: Record<string, SeverityLevel> = {
  critical: "high",
  high: "high",
  error: "high",
  danger: "high",
  warn: "medium",
  warning: "medium",
  medium: "medium",
  low: "low",
  minor: "low",
  info: "info",
  notice: "info",
};

export const SEVERITY_LABELS: Record<SeverityLevel, string> = {
  high: "需要处理",
  medium: "建议处理",
  low: "可以留意",
  info: "提示",
};

const SEVERITY_ORDER: SeverityLevel[] = ["high", "medium", "low", "info"];

export const CATEGORY_LABELS: Record<string, string> = {
  "broken-link": "失效的软链接",
  "missing-skill-md": "缺少 SKILL.md",
  frontmatter: "文件头不完整",
  "name-mismatch": "名称和文件夹不一致",
  oversize: "SKILL.md 过大",
  "differing-copies": "同一个 Agent 里副本不一致",
  "hidden-by-product": "被产品隐藏",
  shadowed: "被同名技能覆盖",
  disabled: "已停用",
  archived: "已归档",
  "missing-bin": "缺少依赖的命令",
  "missing-env": "缺少环境变量",
  "nvm-only": "命令只在 nvm 里",
  "mcp-command-missing": "MCP 命令找不到",
  "mcp-literal-secret": "MCP 配置里有明文密钥",
  "plugin-state": "插件状态",
  "shared-root": "共用的技能文件夹",
  "update-available": "有新版本",
  "locally-modified": "本地改过的技能",
  "lock-drift": "锁记录和本地不一致",
  "codex-tmp-leftovers": "Codex 临时文件残留",
  "library-drift": "和技能库重复的独立副本",
  "library-external-link": "技能库里指向库外的链接",
  "cli-version-skew": "命令行工具版本不一致",
  "cli-workspace-unconfigured": "命令行工具的工作区没配置",
  "cli-not-on-agent-path": "Agent 找不到命令行工具",
};

export const FIX_KIND_LABELS: Record<string, string> = {
  open: "打开查看",
  reinstall: "重新安装",
  "remove-link": "删除失效链接",
  enable: "启用",
  configure: "修改配置",
};

export function severityOf(value: unknown): SeverityLevel {
  return SEVERITY_ALIASES[asString(value).toLowerCase()] || "info";
}

export function normalizeHealthReport(raw: unknown): HealthReport {
  const record = asRecord(raw);
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(asRecord(record.counts))) {
    counts[key] = asNumber(value);
  }
  const findings = asArray(record.findings).map((value, index): HealthFinding => {
    const finding = asRecord(value);
    const fix = asRecord(finding.fix);
    const fixLabel = asString(fix.label);
    return {
      id: asString(finding.id, `finding-${index}`),
      severity: severityOf(finding.severity),
      rawSeverity: asString(finding.severity),
      category: asString(finding.category, "other"),
      title: asString(finding.title, "未命名问题"),
      detail: asString(pick(finding, "detail", "description")),
      agentId: asOptionalString(finding.agentId),
      skillName: asOptionalString(finding.skillName),
      path: asOptionalString(finding.path),
      fix: fixLabel && asString(fix.kind) !== "none" ? { kind: asString(fix.kind), label: fixLabel } : null,
    };
  });
  return {
    generatedAt: asOptionalString(pick(record, "generatedAt", "scannedAt")),
    counts,
    findings,
  };
}

export function groupFindings(findings: HealthFinding[]): SeverityGroup[] {
  return SEVERITY_ORDER.map((severity) => {
    const matching = findings.filter((finding) => finding.severity === severity);
    const byCategory = new Map<string, HealthFinding[]>();
    for (const finding of matching) {
      const list = byCategory.get(finding.category) || [];
      list.push(finding);
      byCategory.set(finding.category, list);
    }
    return {
      severity,
      label: SEVERITY_LABELS[severity],
      total: matching.length,
      categories: [...byCategory.entries()]
        .sort((left, right) => right[1].length - left[1].length)
        .map(([category, list]) => ({
          category,
          label: CATEGORY_LABELS[category] || category,
          findings: list,
        })),
    };
  }).filter((group) => group.total > 0);
}
