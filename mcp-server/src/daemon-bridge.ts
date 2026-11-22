/**
 * The daemon's extension bridge, built in one place (extracted from
 * `Daemon.initialize`: `daemon.ts` sits exactly on the 600-line
 * maintenance gate, so the bridge construction — and the task-answer
 * wiring that came with it — lives here instead of growing that file).
 *
 * The wiring is the daemon side of the human question protocol (specs/
 * 011-professional-browsing-layer, Design §5):
 * - the popup's `taskAnswer` frames are routed to `answerQuestion` with
 *   no continuation: the answer is recorded and the task returns to
 *   `running`. The full resume — continuing with the daemon's `ToolHost`
 *   via `runTask` — is Task 8's binding; `continueWith` is optional, so
 *   the receiver does not invent a host here.
 * - pending questions are restored from disk before the bridge starts
 *   listening, so a daemon restart neither loses them nor wedges their
 *   tasks; a reconnecting extension is re-asked them when it becomes
 *   ready (the bridge's provider hook), so the popup card returns.
 */
import { ExtensionBridge } from './bridge.js';
import { DEFAULT_WS_HOST, DEFAULT_WS_PORT } from './daemon-config.js';
import { answerQuestion, pendingQuestions, restorePendingQuestions } from './tasks/questions.js';
import { createLogger } from './core/logger.js';

const log = createLogger('DaemonBridge');

export interface DaemonBridgeOptions {
  token: string;
  enrollmentSecret: string;
  /** How long a call waits for the extension right after the start or a drop. */
  reconnectWaitMs: number;
  /** The daemon's live session ids, sent to each extension connection when it becomes ready. */
  sessionRoster: () => string[];
}

/** Build the daemon's bridge, wire the task-answer receiver, and restore the pending questions. */
export async function createDaemonBridge(options: DaemonBridgeOptions): Promise<ExtensionBridge> {
  const bridge = new ExtensionBridge({
    port: DEFAULT_WS_PORT,
    host: DEFAULT_WS_HOST,
    token: options.token,
    enrollmentSecret: options.enrollmentSecret,
    // The extension retries after 1, 2 and 4 s: a call right after a daemon restart waits for it.
    reconnectWait: { ms: options.reconnectWaitMs },
  });
  bridge.setSessionRoster(options.sessionRoster);
  bridge.setTaskAnswerHandler((questionId, answer) => answerQuestion(questionId, answer));
  bridge.setPendingTaskQuestionsProvider(() => pendingQuestions());
  try {
    await restorePendingQuestions();
  } catch (error) {
    // A restore failure must not keep the daemon from starting: the tasks
    // stay visibly `paused-question` and answerable once re-asked or via
    // the MCP tool, and the next restore retries.
    const detail = error instanceof Error ? error.message : String(error);
    log.warn(`pending task questions could not be restored: ${detail}`);
  }
  return bridge;
}
