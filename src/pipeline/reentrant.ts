import type {
  Artifact,
  InteractionResponse,
  PendingInteraction,
  PersistedStageState,
  StageContext,
} from "./types.js";
import type { StageFailedClosedError } from "../runtime/errors.js";

export type StageRunStep =
  | {
      status: "awaiting_input";
      state: PersistedStageState;
      interaction: PendingInteraction;
    }
  | {
      status: "awaiting_confirmation";
      state: PersistedStageState;
      artifacts: Artifact[];
    }
  | {
      status: "failed";
      state: PersistedStageState;
      error: StageFailedClosedError;
    };

export interface ReentrantStageRunner {
  start(ctx: StageContext): Promise<StageRunStep>;
  resume(ctx: StageContext, response: InteractionResponse): Promise<StageRunStep>;
}
