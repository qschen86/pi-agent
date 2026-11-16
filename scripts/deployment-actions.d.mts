export function withDeploymentActions<T>(home: string, action: () => T): T;
export function transitionDeployment(file: string, sha: string, phase: string): boolean;

export function deploymentActionsSupported(root: string): boolean;
