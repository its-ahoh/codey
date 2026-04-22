export class CodeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WorkerNotFoundError extends CodeyError {
  constructor(public readonly workerName: string) {
    super(`Worker not found: ${workerName}`);
  }
}

export class WorkspaceNotFoundError extends CodeyError {
  constructor(public readonly workspaceName: string) {
    super(`Workspace not found: ${workspaceName}`);
  }
}

export class AgentSpawnError extends CodeyError {
  constructor(public readonly agent: string, message: string) {
    super(`Failed to spawn agent "${agent}": ${message}`);
  }
}
