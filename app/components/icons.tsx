import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, strokeWidth = 1.6, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const HomeIcon = (props: IconProps) => (
  <Icon {...props}><path d="M3.5 9 10 3.8 16.5 9v7a1 1 0 0 1-1 1h-3.2v-4.6H7.7V17H4.5a1 1 0 0 1-1-1V9Z" /></Icon>
);
export const SkillsIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 3.5h8.5a1.5 1.5 0 0 1 1.5 1.5v11.5H6.5A1.5 1.5 0 0 1 5 15V3.5Z" />
    <path d="M5 15a1.5 1.5 0 0 1 1.5-1.5H15M8 7h4M8 10h3" />
  </Icon>
);
export const PluginsIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 3.5h4v2.2a1.6 1.6 0 1 0 3.2 0V3.5h1.3v4.3h-2.2a1.6 1.6 0 1 0 0 3.2h2.2v5.5H12v-2.2a1.6 1.6 0 1 0-3.2 0v2.2H3.5V11h2.2a1.6 1.6 0 1 0 0-3.2H3.5V3.5H8Z" />
  </Icon>
);
export const ConnectorsIcon = (props: IconProps) => (
  <Icon {...props}><path d="M7 3.5v3M13 3.5v3M5.5 6.5h9v3a4.5 4.5 0 0 1-9 0v-3ZM10 14v2.5" /></Icon>
);
export const ExpertsIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="7.5" cy="7" r="2.6" />
    <path d="M2.8 16c.5-2.6 2.4-4.1 4.7-4.1s4.2 1.5 4.7 4.1" />
    <circle cx="14" cy="7.8" r="2.1" />
    <path d="M13.3 11.9c2 .1 3.5 1.4 3.9 3.6" />
  </Icon>
);
export const UsageIcon = (props: IconProps) => (
  <Icon {...props}><path d="M3.5 16.5h13M5.5 13.5V9.5M9 13.5V5.5M12.5 13.5v-6M16 13.5v-3" /></Icon>
);
export const HealthIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M10 16.5s-6-3.4-6-8.2A3.3 3.3 0 0 1 10 6.4a3.3 3.3 0 0 1 6 1.9c0 4.8-6 8.2-6 8.2Z" />
    <path d="M6.8 10.2h1.9l1-1.8 1.4 3.3 1-1.5h1.6" />
  </Icon>
);
export const SettingsIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="10" cy="10" r="2.4" />
    <path d="M10 3v1.6M10 15.4V17M17 10h-1.6M4.6 10H3M14.95 5.05l-1.13 1.13M6.18 13.82l-1.13 1.13M14.95 14.95l-1.13-1.13M6.18 6.18 5.05 5.05" />
  </Icon>
);
export const SearchIcon = (props: IconProps) => (
  <Icon strokeWidth={1.8} {...props}><circle cx="9" cy="9" r="5.2" /><path d="m13 13 3.5 3.5" /></Icon>
);
export const RefreshIcon = (props: IconProps) => (
  <Icon strokeWidth={1.7} {...props}>
    <path d="M15.5 8.5A5.6 5.6 0 0 0 5 6.6M4.5 11.5A5.6 5.6 0 0 0 15 13.4" />
    <path d="M5 3.5v3.3h3.3M15 16.5v-3.3h-3.3" />
  </Icon>
);
export const PlusIcon = (props: IconProps) => (
  <Icon strokeWidth={1.8} {...props}><path d="M10 4.5v11M4.5 10h11" /></Icon>
);
export const CopiesIcon = (props: IconProps) => (
  <Icon strokeWidth={1.7} {...props}>
    <rect x="6.5" y="6.5" width="9" height="9" rx="2" />
    <path d="M13.5 6.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v7A1.5 1.5 0 0 0 5 13.5h1.5" />
  </Icon>
);
export const KeyIcon = (props: IconProps) => (
  <Icon strokeWidth={1.7} {...props}>
    <circle cx="7" cy="12.5" r="3.2" />
    <path d="m9.3 10.2 6.2-6.2M13.2 6.3l1.9 1.9M11.6 7.9l1.5 1.5" />
  </Icon>
);
export const CheckIcon = (props: IconProps) => (
  <Icon strokeWidth={1.9} {...props}><path d="m4.5 10.5 3.5 3.5 7.5-8" /></Icon>
);
export const FinderIcon = (props: IconProps) => (
  <Icon strokeWidth={1.7} {...props}>
    <path d="M3.5 6A1.5 1.5 0 0 1 5 4.5h3l1.5 1.7H15A1.5 1.5 0 0 1 16.5 7.7V14A1.5 1.5 0 0 1 15 15.5H5A1.5 1.5 0 0 1 3.5 14V6Z" />
  </Icon>
);
export const ExportIcon = (props: IconProps) => (
  <Icon strokeWidth={1.7} {...props}>
    <path d="M10 3.5v9M6.5 7 10 3.5 13.5 7M4.5 12.5v2a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-2" />
  </Icon>
);
export const CloseIcon = (props: IconProps) => (
  <Icon strokeWidth={1.8} {...props}><path d="m5.5 5.5 9 9M14.5 5.5l-9 9" /></Icon>
);
export const ChevronIcon = (props: IconProps) => (
  <Icon strokeWidth={1.8} {...props}><path d="m7.5 5 5 5-5 5" /></Icon>
);
export const FileIcon = (props: IconProps) => (
  <Icon strokeWidth={1.5} {...props}>
    <path d="M5.5 3.5h6l3 3v10h-9v-13Z" />
    <path d="M11.5 3.5v3h3" />
  </Icon>
);
export const FolderIcon = (props: IconProps) => (
  <Icon strokeWidth={1.5} {...props}>
    <path d="M3.5 6A1.5 1.5 0 0 1 5 4.5h3l1.5 1.7H15A1.5 1.5 0 0 1 16.5 7.7V14A1.5 1.5 0 0 1 15 15.5H5A1.5 1.5 0 0 1 3.5 14V6Z" />
  </Icon>
);
export const WarnIcon = (props: IconProps) => (
  <Icon strokeWidth={1.7} {...props}>
    <path d="M10 3.8 17 16H3L10 3.8Z" />
    <path d="M10 8.5v3.3M10 14v.01" />
  </Icon>
);
export const LockIcon = (props: IconProps) => (
  <Icon strokeWidth={1.6} {...props}>
    <rect x="4.5" y="9" width="11" height="7.5" rx="1.6" />
    <path d="M7 9V7a3 3 0 0 1 6 0v2" />
  </Icon>
);
export const LinkIcon = (props: IconProps) => (
  <Icon strokeWidth={1.6} {...props}>
    <path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-.9.9" />
    <path d="M11.5 8.5a3 3 0 0 0-4.2 0L5 10.8A3 3 0 0 0 9.2 15l.9-.9" />
  </Icon>
);
export const InfoIcon = (props: IconProps) => (
  <Icon strokeWidth={1.7} {...props}>
    <circle cx="10" cy="10" r="6.5" />
    <path d="M10 9v4.2M10 6.6v.01" />
  </Icon>
);
export const UpdateIcon = (props: IconProps) => (
  <Icon strokeWidth={1.6} {...props}>
    <path d="M10 3.5v8.5M6.5 8.5 10 12l3.5-3.5" />
    <path d="M4 14.5v1a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-1" />
  </Icon>
);
export const LibraryIcon = (props: IconProps) => (
  <Icon strokeWidth={1.6} {...props}>
    <path d="M4 4.5h3v11H4zM8.5 4.5h3v11h-3z" />
    <path d="m13 5.2 2.8-.7 2.2 10.4-2.8.7z" />
  </Icon>
);
export const SparkIcon = (props: IconProps) => (
  <Icon strokeWidth={1.6} {...props}>
    <path d="M10 3.5c.4 3.3 1.9 5 5.5 5.5-3.6.5-5.1 2.2-5.5 5.5-.4-3.3-1.9-5-5.5-5.5 3.6-.5 5.1-2.2 5.5-5.5Z" />
    <path d="M15 13.5v3M13.5 15h3" />
  </Icon>
);
