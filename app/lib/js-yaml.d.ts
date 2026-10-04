// Minimal typings for the js-yaml 4 functions the UI uses (the package ships no types).
declare module "js-yaml" {
  export interface LoadOptions {
    filename?: string;
    json?: boolean;
  }
  export interface DumpOptions {
    indent?: number;
    lineWidth?: number;
    noRefs?: boolean;
    skipInvalid?: boolean;
    flowLevel?: number;
  }
  export function load(text: string, options?: LoadOptions): unknown;
  export function dump(value: unknown, options?: DumpOptions): string;
}
