/**
 * Shapes returned by the loopback manager service (server/local-server.mjs).
 * Optional fields are newer additions or adapter-specific; the UI must not assume them.
 */

export type SyncMode = "copy" | "symlink";
export type PluginEnabled = boolean | "unknown";

export interface AgentRoot {
  configuredPath: string;
  path: string;
  realPath?: string;
  available: boolean;
  skillCount: number;
}

export interface ScanAgent {
  id: string;
  name: string;
  shortName: string;
  color: string;
  paths: string[];
  roots: AgentRoot[];
  available: boolean;
  visible: boolean;
  installationCount: number;
  skillCount: number;
  adapter?: boolean;
  installRoot?: string | null;
  copyOnly?: boolean;
  refuseInstall?: string | null;
  archivedCount?: number;
  managedBy?: string[] | null;
  productVersion?: string | null;
  /** Newer services: only request /api/agent-icon when true. */
  iconAvailable?: boolean;
}

export interface InstanceUsage {
  count?: number | null;
  lastUsedAt?: string | null;
  state?: string | null;
  pinned?: boolean;
  confidence?: string | null;
  windowDays?: number | null;
}

export interface SkillInstance {
  id: string;
  agentId: string;
  agentName: string;
  root: string;
  path: string;
  directoryName: string;
  name: string;
  displayName: string;
  version?: string | null;
  hash: string;
  shortHash: string;
  fileCount: number;
  byteCount: number;
  modifiedAt: string | null;
  isSymlink: boolean;
  source?: string;
  sourceLabel?: string;
  managed?: boolean;
  readOnly?: boolean;
  aliases?: string[];
  realPathId?: string;
  sharedWith?: string[];
  disabled?: boolean;
  disabledOn?: string[];
  shadowed?: boolean;
  shadowedBy?: string | null;
  hiddenByProduct?: string | null;
  usage?: InstanceUsage | null;
  profile?: string | null;
}

export interface SkillNewest {
  agentId: string;
  instanceId: string;
  modifiedAt: string | null;
  version: string | null;
  shortHash: string;
}

export interface SkillDuplicate {
  agentId: string;
  count: number;
  identical: boolean;
}

export interface Skill {
  id: string;
  name: string;
  displayName: string;
  description: string;
  descriptionZh?: string | null;
  tags: string[];
  status: string;
  conflict: boolean;
  coverage: number;
  installedAgentIds: string[];
  missingAgentIds: string[];
  hashes: string[];
  modifiedAt: string | null;
  fileCount: number;
  managed?: string[];
  duplicates?: SkillDuplicate[];
  inPrimary?: boolean;
  installedPrimary?: string[];
  missingPrimary?: string[];
  primaryStatus?: "ok" | "differs";
  newest?: SkillNewest | null;
  behind?: string[];
  diverged?: boolean;
  instances: SkillInstance[];
}

export interface ActivityAgent {
  agentId: string;
  status: string;
  basis: string;
  files30d: number;
  bytes30d: number;
  weight30d: number;
  activeDays30d: number;
  lastActiveAt: string | null;
  truncated: boolean;
  tokens30d?: number;
  costUsd30d?: number;
  skillReads30d?: number;
}

export interface AgentActivity {
  windowDays: number;
  rankedBy?: string;
  agents: ActivityAgent[];
  suggestedPrimaryAgentIds: string[];
  warnings?: string[];
  scannedAt?: string;
}

export interface SharedRoot {
  realPath: string;
  realPathId: string;
  roots: { agentId: string; path: string }[];
  agentIds: string[];
  managedBy: string | null;
}

export interface ScanSummary {
  total: number;
  inPrimary: number;
  differs: number;
  duplicates: { total: number; identical: number; differing: number };
  sharedRoots: number;
}

export interface HistoryEntry {
  id: string;
  type: string;
  skillName: string;
  mode: SyncMode;
  targets: string[];
  backups: number;
  createdAt: string;
}

export interface ScanData {
  agents: ScanAgent[];
  skills: Skill[];
  primaryAgentIds: string[] | null;
  suggestedPrimaryAgentIds: string[];
  effectivePrimaryAgentIds: string[];
  agentActivity?: AgentActivity | null;
  sharedRoots?: SharedRoot[];
  archivedSkills?: Skill[];
  summary?: ScanSummary;
  totals: {
    uniqueSkills: number;
    installations: number;
    synced: number;
    conflicts: number;
    incomplete: number;
    coverage: number;
  };
  history: HistoryEntry[];
  scannedAt: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  shortName: string;
  color: string;
  paths: string[];
}

export interface ManagerConfig {
  version: number;
  syncMode: SyncMode;
  agents: AgentConfig[];
  visibleAgentIds: string[];
  primaryAgentIds?: string[] | null;
  dismissedAgentIds: string[];
  /** False until the user first changes which Agents are visible (all detected ones show). */
  visibleCustomized?: boolean;
}

export interface PluginApp {
  key: string;
  connectorId?: string | null;
}

export interface PluginComponents {
  skills: string[];
  mcpServers: { name: string; transport?: string }[];
  apps: PluginApp[];
  hooks: boolean;
  agents?: string[];
  commands?: string[];
  channels?: string[];
}

export interface Plugin {
  id: string;
  key: string;
  agentId: string;
  kind?: string;
  name: string;
  marketplace: string;
  displayName: string;
  shortDescription: string;
  longDescription: string;
  category: string;
  developerName: string;
  brandColor: string | null;
  keywords: string[];
  version: string;
  versions: string[];
  enabled: PluginEnabled;
  configured: boolean;
  installed: boolean;
  scope: string;
  projectPath?: string | null;
  source: string;
  manifestStatus: string;
  components: PluginComponents;
  logo: string | null;
  logoDark: string | null;
  composerIcon: string | null;
  installedAt?: string;
  lastUpdated?: string;
}

export interface Connector {
  id: string;
  name: string;
  namespace?: string;
  description: string;
  toolCount: number;
  toolNames: string[];
  providedByPlugins: string[];
  source?: string;
  cachedAt?: string;
}

export interface McpServer {
  id: string;
  name: string;
  agentId: string;
  scope: string;
  projectPath: string | null;
  transport: string;
  host: string | null;
  enabled: boolean | null;
  secretFields: string[];
  likelySecretFields: string[];
  source: string;
}

export interface McpMatrixRow {
  name: string;
  agentIds: string[];
  entries: {
    agentId: string;
    scope: string;
    projectPath: string | null;
    transport: string;
    enabled: boolean | null;
  }[];
}

export interface RelatedProduct {
  id: string;
  name: string;
  kind: string;
  bundleId: string | null;
  version: string | null;
  stateDir: string | null;
  notes: string;
}

export interface IntegrationsData {
  plugins: Plugin[];
  connectors: Connector[];
  mcpServers: McpServer[];
  mcpMatrix: McpMatrixRow[];
  relatedProducts: RelatedProduct[];
  sources: Record<string, { available?: boolean; connectorsCachedAt?: string } | undefined>;
  warnings: string[];
  scannedAt: string;
}

export interface CapabilityMember {
  id: string;
  name: string;
  displayName: string;
  profession: string;
  description: string;
  maxTurns: number | null;
  filePath: string;
  avatar?: string | null;
}

export interface Capability {
  id: string;
  productId: string;
  productName: string;
  productColor: string;
  kind: string;
  kindLabel: string;
  origin?: string;
  originLabel?: string;
  name: string;
  displayName: string;
  description: string;
  profession: string;
  version: string;
  tags: string[];
  members: CapabilityMember[];
  memberCount: number;
  fileCount: number;
  skillCount: number;
  model: string;
  sourcePath: string;
  primaryFilePath: string | null;
  modifiedAt: string;
  category?: string;
  defaultPrompt?: string;
  quickPrompts?: string[];
  skills?: string[];
  avatar?: string | null;
  packaged?: boolean;
  installed?: boolean;
  inUse?: boolean;
  installedVersion?: string | null;
  used?: { count: number; lastUsedAt: string | null } | null;
  emoji?: string | null;
  isDefault?: boolean;
  workspacePath?: string;
  managedBy?: string[];
  maxTurns?: number | null;
  cronJobs?: number;
  plugins?: string[];
}

export interface CapabilityProduct {
  id: string;
  name: string;
  color: string;
  kindLabel: string;
  sourcePath: string;
  available: boolean;
  catalogCount: number;
  itemCount: number;
  memberCount: number;
  items: Capability[];
}

export interface CapabilityCatalog {
  products: CapabilityProduct[];
  totals: { products: number; profiles: number; members: number };
  scannedAt: string;
}

export interface ConfigDetailFile {
  path: string;
  label: string | null;
  language: string;
  text: string;
  truncated: boolean;
}

export interface ConfigDetail {
  title: string;
  location: string | null;
  rows: { label: string; value: string }[];
  files: ConfigDetailFile[];
}

export interface FileEntry {
  path: string;
  name: string;
  type: "file" | "directory" | "symlink";
  size: number;
  modifiedAt: string;
  language: string | null;
  linkTarget: string | null;
}

export interface FileListing {
  entries: FileEntry[];
  fileCount: number;
  directoryCount: number;
  truncated: boolean;
}

export interface FileContent {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  language: string;
  mimeType: string | null;
  previewKind: "text" | "image" | "unavailable";
  content: string | null;
  previewable: boolean;
  reason: string | null;
}

export interface SyncAction {
  agentId: string;
  agentName: string;
  action: "noop" | "replace" | "create";
  mode: SyncMode;
  source: string;
  destination: string;
  realDestination?: string;
  viaSymlink?: boolean;
  reason?: string | null;
  sharedWithAgentId?: string | null;
  alsoVisibleTo?: string[];
  backup: string | null;
  sourceHash: string;
  targetHash: string | null;
  identical: boolean;
  skippedLinks?: { path: string; reason: string }[];
  result?: "skipped" | "completed";
}

export interface SyncPlan {
  skillId?: string;
  skillName: string;
  displayName?: string;
  importId?: string;
  sourceInstanceId?: string;
  sourceAgentId?: string;
  mode?: SyncMode;
  actions: SyncAction[];
  backupGroup?: string;
  sharedDestinations?: { realPath: string; agentIds: string[] }[];
  warnings?: string[];
  historyEntry?: HistoryEntry;
}

export interface ImportedSkill {
  importId: string;
  originalFilename: string;
  directoryName: string;
  name: string;
  displayName: string;
  description: string;
  tags: string[];
  fileCount: number;
  directoryCount: number;
  byteCount: number;
  shortHash: string;
  entries: FileEntry[];
}
