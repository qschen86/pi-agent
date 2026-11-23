export const NETWORK_REPORT_TTL_MS: number;
export interface NetworkDecision {
  runtime: string;
  allowed: boolean;
  reasons: string[];
  accountSafetyGuaranteed: false;
}
export function evaluateRuntimeNetwork(input: {
  runtime: string;
  report?: unknown;
  networkId?: string;
  now?: number;
}): NetworkDecision;
export function withRuntimeNetworkGate<T>(input: {
  runtime: string;
  stage: 'install' | 'login' | 'first-task';
  inspect: (runtime: string) => Promise<{ report: unknown; networkId: string; failure?: string }>;
  operation: () => Promise<T> | T;
  now?: () => number;
}): Promise<T>;
