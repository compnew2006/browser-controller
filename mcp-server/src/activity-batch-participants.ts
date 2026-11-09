import { ACTION_ACTIVITY_CAPABILITY } from './protocol/capabilities.js';
import { buildExtensionActivityBatchFinishedFrame, type ActivityContextFrame, type BatchFinishedFrame } from './protocol/frames.js';
import { ExtensionConnections, type ExtensionConnection } from './bridge-connections.js';

interface ParticipantRecord {
  connections: Set<ExtensionConnection>;
  expiresAt: number;
}

const PARTICIPANT_CAP = 200;
const PARTICIPANT_TTL_MS = 5 * 60_000;

/** Tracks only live sockets that received a child action for a session and batch. */
export class ActivityBatchParticipants {
  private participants = new Map<string, ParticipantRecord>();

  constructor(private readonly connections: ExtensionConnections) {}

  sendToolCall(
    connection: ExtensionConnection,
    id: string,
    tool: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
    agentName: string | undefined,
    activityContext?: ActivityContextFrame,
  ): void {
    const supportedActivity = connection.capabilities.includes(ACTION_ACTIVITY_CAPABILITY) ? activityContext : undefined;
    connection.ws.send(JSON.stringify({ id, tool, params, sessionId, agentName, activityContext: supportedActivity }));
    if (supportedActivity?.batchRunId && sessionId) this.note(sessionId, supportedActivity.batchRunId, connection);
  }

  note(sessionId: string, batchRunId: string, connection: ExtensionConnection): void {
    const now = Date.now();
    for (const [key, record] of this.participants) {
      if (record.expiresAt <= now) this.participants.delete(key);
    }
    const key = `${sessionId}\u0000${batchRunId}`;
    let record = this.participants.get(key);
    if (!record) {
      while (this.participants.size >= PARTICIPANT_CAP) {
        const oldest = this.participants.keys().next().value;
        if (oldest === undefined) break;
        this.participants.delete(oldest);
      }
      record = { connections: new Set(), expiresAt: now + PARTICIPANT_TTL_MS };
      this.participants.set(key, record);
    }
    record.connections.add(connection);
  }

  /** Notify only live extension sockets that actually received this session's batch actions. */
  finish(sessionId: string, marker: BatchFinishedFrame): number {
    const key = `${sessionId}\u0000${marker.batchRunId}`;
    const record = this.participants.get(key);
    this.participants.delete(key);
    if (!record || record.expiresAt <= Date.now()) return 0;
    const frame = JSON.stringify(buildExtensionActivityBatchFinishedFrame(marker));
    let sent = 0;
    for (const connection of record.connections) {
      if (!this.connections.has(connection) || !ExtensionConnections.isLive(connection)
        || !connection.capabilities.includes(ACTION_ACTIVITY_CAPABILITY)) continue;
      try {
        connection.ws.send(frame);
        sent++;
      } catch {
        // A participant that closed after the live check is simply unavailable.
      }
    }
    return sent;
  }

  clear(): void {
    this.participants.clear();
  }
}
