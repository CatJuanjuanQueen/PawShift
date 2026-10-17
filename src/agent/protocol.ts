/** Only the stable app-server fields used by PawShift. Verified against the local CLI schema. */
export type SandboxPolicy =
  | {
      type: 'readOnly';
      networkAccess: boolean;
    }
  | {
      type: 'workspaceWrite';
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };
export interface ThreadStartParams {
  cwd: string;
  model?: string;
  sandbox: 'read-only' | 'workspace-write';
  approvalPolicy: 'untrusted';
  approvalsReviewer: 'user';
  ephemeral: boolean;
}
export interface TurnStartParams {
  threadId: string;
  input: {
    type: 'text';
    text: string;
    text_elements: unknown[];
  }[];
  sandboxPolicy: SandboxPolicy;
  approvalPolicy: 'untrusted';
}
