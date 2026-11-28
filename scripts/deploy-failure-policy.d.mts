export interface FailureDetail { file?: string; test?: string; phase?: string; kind: string; error: string }
export interface FailureResult {
  version: 1; status: string; key?: string; phase: string; failures: FailureDetail[];
  fingerprint: string; confirmations: number; at: string;
  logFile?: string; [key: string]: unknown;
}
export function hash(value: string | Uint8Array): string;
export function writeResult(file: string, value: unknown): void;
export function readResult(file: string): FailureResult | undefined;
export function classifyFailure(error: string): string;
export function reportFailures(report: unknown, repo: string, files: string[]): FailureDetail[];
export function mayConfirm(failures: FailureDetail[]): boolean;
export function failureFingerprint(failures: FailureDetail[]): string;
export function failureResult(input: { key?: string; failures: FailureDetail[]; phase: string; confirmations?: number; [key: string]: unknown }): FailureResult;
export function deploymentIdentity(input: { repo: string; sha: string; root: string; base?: string; branch?: string; env?: NodeJS.ProcessEnv }): string;
export function deploymentFailureFile(root: string, key: string): string;
export function blockedDeployment(root: string, key: string): FailureResult | undefined;
export function unchangedFailure(record: FailureResult): Error & { code: string; failure: FailureResult };
