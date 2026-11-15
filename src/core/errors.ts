export class SubagentError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConfigurationError extends SubagentError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, "CONFIGURATION_ERROR", details);
  }
}

export class ConfigInvalidError extends SubagentError {
  constructor(warning: string) {
    super(`subagent-mcp cannot run agents until the configuration is fixed. ${warning}`, "CONFIG_INVALID", {
      warning,
    });
  }
}

export class CapacityError extends SubagentError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, "CAPACITY_EXCEEDED", details);
  }
}

export class ApprovalError extends SubagentError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, "APPROVAL_ERROR", details);
  }
}
