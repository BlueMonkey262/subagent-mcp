import type { PermissionConfig } from "../config/schema.js";
import type { Backend } from "../core/types.js";
import type { SelectionCriteria, SelectionReport } from "../routing/model-selector.js";

export const ENSEMBLE_MODES = ["parallel", "specialist", "competitive", "pipeline"] as const;
export type EnsembleMode = (typeof ENSEMBLE_MODES)[number];

export const COMPLETION_STRATEGIES = ["all", "first_valid", "quorum", "deadline"] as const;
export type CompletionStrategy = (typeof COMPLETION_STRATEGIES)[number];

export const AGGREGATION_STRATEGIES = ["collect", "compare", "vote", "merge", "review_findings"] as const;
export type AggregationStrategy = (typeof AGGREGATION_STRATEGIES)[number];

export const ISOLATION_MODES = ["none", "worktree", "snapshot"] as const;
export type IsolationMode = (typeof ISOLATION_MODES)[number];

export const ENSEMBLE_STATUSES = ["launching", "running", "synthesizing", "completed", "partial", "failed", "cancelled", "interrupted"] as const;
export type EnsembleStatus = (typeof ENSEMBLE_STATUSES)[number];
export const FINAL_STATUSES: ReadonlySet<EnsembleStatus> = new Set(["completed", "partial", "failed", "cancelled", "interrupted"]);

/** Hard cap on members per ensemble, so one call can never fan out into an unbounded number of paid agents. */
export const MAX_ENSEMBLE_MEMBERS = 12;
export const DEFAULT_MAX_CHARS = 1_600;
/** Reserved role of the optional synthesis agent; member roles cannot start with "_". */
export const SYNTHESIS_ROLE = "_synthesis";

export interface MemberSpec {
  readonly role: string;
  /** Agent config name (.subagents/<config>.md). Filled by model selection when the member uses `select`. */
  readonly config?: string;
  readonly backend?: Backend;
  readonly model?: string;
  readonly effort?: string;
  /** Let the model selector pick config and model for this member. Ignored once config is set. */
  readonly select?: SelectionCriteria;
  /** Appended to the shared task for this member only. */
  readonly instructions?: string;
  readonly result_schema?: Record<string, unknown>;
  /** none: the parent's checkout; worktree: a managed worktree at HEAD; snapshot: a worktree holding the working tree as it was at start. */
  readonly isolation?: IsolationMode;
  readonly timeout?: number;
  readonly max_turns?: number;
  readonly permission?: PermissionConfig;
  /** Roles of earlier members whose results this member receives. */
  readonly depends_on?: readonly string[];
  /**
   * block (default): start only after every dependency succeeds (spawn_agent depends_on semantics).
   * continue: start once every dependency has settled, successful or not, with their outcomes.
   */
  readonly on_dependency_failure?: "block" | "continue";
  /** continue only: characters of each dependency's result passed on (default 4000). */
  readonly dependency_max_chars?: number;
}

export interface CompletionSpec {
  readonly strategy: CompletionStrategy;
  readonly quorum?: number;
  /** Finalize with what is available after this many seconds. Required for `deadline`; a cap for the others. */
  readonly deadline_seconds?: number;
  /** Stop members still running once the ensemble finalizes. Default false. */
  readonly cancel_remaining: boolean;
  /** When false, any failed or invalid member fails the ensemble. Default true. */
  readonly allow_partial: boolean;
}

export interface SynthesisSpec {
  readonly config: string;
  readonly model?: string | undefined;
  readonly backend?: Backend | undefined;
  readonly effort?: string | undefined;
  /** Characters of aggregate and member results handed to the synthesizer (default 12000). */
  readonly max_input_chars: number;
  readonly timeout_seconds: number;
  readonly instructions?: string | undefined;
}

export interface AggregationSpec {
  readonly strategy: AggregationStrategy;
  readonly max_items: number;
  /** vote: dotted path of the answer in each structured result. Default "answer". */
  readonly field?: string;
  /** vote: the allowed answers; also generates the result schema when none is given. */
  readonly choices?: readonly (string | number | boolean)[];
  /** merge: role order that decides a conflicting value (the conflict is still reported). */
  readonly prefer?: readonly string[];
  /** Opt-in model-assisted synthesis on top of the deterministic aggregate. */
  readonly synthesize?: SynthesisSpec;
}

export interface OutputSpec {
  readonly max_chars: number;
  readonly suppress_child_notifications: boolean;
}

export interface BudgetSpec {
  readonly max_cost_usd?: number;
  readonly max_total_tokens?: number;
}

export interface EnsembleSelectionSpec extends SelectionCriteria {
  readonly count: number;
  readonly roles?: readonly string[] | undefined;
}

export interface EnsembleSpec {
  readonly name: string;
  readonly profile?: string;
  readonly task: string;
  /** Task category, used by model selection and recorded with each outcome. */
  readonly category?: string;
  readonly mode: EnsembleMode;
  readonly agents: readonly MemberSpec[];
  readonly selection?: EnsembleSelectionSpec;
  readonly result_schema?: Record<string, unknown>;
  readonly completion: CompletionSpec;
  readonly aggregation: AggregationSpec;
  readonly output: OutputSpec;
  readonly budget?: BudgetSpec;
  readonly run_in_background: boolean;
}

export type LaunchState = "pending" | "launching" | "launched" | "failed" | "skipped";

export interface MemberRecord {
  readonly role: string;
  config: string;
  backend?: Backend;
  model?: string;
  launch: LaunchState;
  /** Supervisor agent id, or a queued task id until a dependency-gated member starts. */
  agent_id?: string;
  name?: string;
  state: string;
  valid?: boolean;
  /** Why a settled member's result does not count. */
  invalid_reason?: string;
  /** "structured", "recovered" (JSON pulled out of prose or a code fence), or "text". */
  value_source?: "structured" | "recovered" | "text";
  error?: string;
  /** Branch of the member's managed worktree, when isolated. */
  branch?: string;
  launched_at?: string;
  settled_at?: string;
  /** True when the member settled after the ensemble finalized. */
  late?: boolean;
  /** True once this member's outcome is in the routing history. */
  recorded?: boolean;
  usage?: Readonly<Record<string, number | null>>;
}

export interface SynthesisRecord {
  state: "launching" | "running" | "completed" | "failed" | "skipped";
  agent_id?: string;
  name?: string;
  model?: string;
  result?: unknown;
  reason?: string;
}

export interface EnsembleRecord {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly created_at: string;
  updated_at: string;
  finished_at?: string;
  status: EnsembleStatus;
  /** What ended the run: policy_satisfied, all_settled, quorum_unreachable, deadline, budget, cancelled. */
  reason?: string;
  /** Decided while synthesis runs; becomes `status` when it ends. */
  pending_final?: { readonly status: EnsembleStatus; readonly reason: string };
  readonly spec: EnsembleSpec;
  readonly group_id: string;
  /** Source snapshot shared by snapshot-isolated members. */
  snapshot?: { readonly commit: string; readonly base: string; readonly dirty: boolean };
  /** How selected members were chosen. */
  selection?: SelectionReport;
  members: MemberRecord[];
  summary?: Readonly<Record<string, unknown>>;
  synthesis?: SynthesisRecord;
  usage?: Readonly<Record<string, unknown>>;
  notification: { required: boolean; state: "pending" | "delivered" | "not_required"; at?: string };
  /** A follow-up event once members still running at finalization have all settled. */
  late_update?: { state: "pending" | "delivered" | "not_required" };
  warnings: string[];
}

/** One member's settled output as aggregators see it. */
export interface MemberResult {
  readonly role: string;
  readonly name?: string;
  readonly model?: string;
  readonly branch?: string;
  readonly state: string;
  readonly valid: boolean;
  readonly value?: unknown;
  readonly text?: string;
  readonly reason?: string;
}

export type Aggregate = Readonly<Record<string, unknown>>;
