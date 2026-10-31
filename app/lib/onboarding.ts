import { persistentStore } from "./storage";

/**
 * First run, in two steps: what Skill Control reads and does (step 1), then 常用 Agent
 * (step 2). 稍后再说 is remembered across starts; 概览 then shows a banner instead.
 */
export const onboardingLaterStore = persistentStore<"" | "1">("onboarding-later", "", (value) => value === "" || value === "1");


export const PRIVACY_URL = "https://github.com/zifeixu85/skill-control/blob/main/PRIVACY.md";

type NetworkConfig = { network?: { updateChecks?: boolean; noticeSeenAt?: string | null; envOffline?: boolean } } | null | undefined;

/** 自动检查更新: on unless the user turned it off (config.network.updateChecks === false). */
export const updateChecksOn = (config: NetworkConfig): boolean => config?.network?.updateChecks !== false;

/** The user has seen the 联网 notice (the service records the time; older configs say "before-0.3"). */
export const noticeSeen = (config: NetworkConfig): boolean => Boolean(config?.network?.noticeSeenAt);

/** SKILL_MANAGER_UPDATES_OFFLINE turned every network call off; the switch can't change that. */
export const envOffline = (config: NetworkConfig): boolean => config?.network?.envOffline === true;

/** The write after the notice: the choice, and "seen" (the service stamps the time once). */
export const networkPatch = (updateChecks: boolean) => ({ network: { updateChecks, noticeSeen: true } });

export const ENV_OFFLINE_TEXT = "已被环境变量关闭（SKILL_MANAGER_UPDATES_OFFLINE），不会联网检查。";

/** What the first step promises, one line each; every claim matches what the service does. */
export const PROMISES: { title: string; detail: string }[] = [
  { title: "会读取", detail: "各 Agent 的技能目录和配置；会话记录只用来统计次数和 Token。" },
  { title: "只在本机统计", detail: "只保存数字，不保存、不上传对话内容；密钥只在本机保存一个加盐指纹，用来判断是否变化。" },
  { title: "改动先给你看", detail: "安装、整理、更新前先列出每一步，确认后才执行，之后可以撤销。" },
  { title: "会联网检查更新", detail: "从 GitHub、npm 和各 Agent 的官方更新地址查 Skill Control 与各 Agent 的新版本，不上传本机数据。" },
];
