export const ONBOARDING_MARK: string;
export const ONBOARDING_TITLE: string;
export const ONBOARDING_KIND: string;
export const ONBOARDING_REPLIES: readonly { readonly label: string; readonly text: string }[];
export function onboardingPrompt(): string;
export function onboardingRepliesFor(installation: unknown, platformSessionId: string, turnCount: number): { label: string; text: string }[] | undefined;
