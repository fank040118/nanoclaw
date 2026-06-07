/**
 * Progress-reaction module (Carbon customization).
 *
 * A three-stage reaction on the user's own inbound message that mirrors the
 * message lifecycle, so a long, tool-heavy turn is legible at a glance:
 *
 *   👀 received — the host routed the message to a session (set in the router,
 *                 even when the message doesn't engage the agent: "I saw it").
 *   🔧 working  — the container claimed the message and is running the agent
 *                 (processing_ack → 'processing').
 *   ✅ done     — the agent's turn finished (processing_ack → 'completed').
 *
 * The stages swap in place (one reaction at a time). ✅ persists — and it is
 * driven by turn completion, *independently of reply delivery*. So a ✅ with no
 * reply in the channel means the turn finished but the answer never made it out
 * (a crash or delivery failure after completion), which is otherwise invisible.
 *
 * Failure is intentionally NOT a distinct stage: the container never writes a
 * 'failed' status, and a genuine hang is caught by host-sweep's claim-stuck
 * kill. So "🔧 that never becomes ✅" *is* the failure signal.
 *
 * Platform emoji sets differ. Telegram bots may only react with a fixed set
 * (👀 is in it, 🔧/✅ are not), so Telegram uses ✍️/👌 substitutes. Discord
 * accepts arbitrary emoji.
 *
 * Design notes:
 *  - Host-side only. Reactions are a platform operation (the container can't
 *    touch the platform directly), driven from the delivery poll which already
 *    reads outbound.db — ~1s latency for running sessions.
 *  - Best-effort throughout: every add/remove is fire-and-forget and swallows
 *    its own errors. A reaction failure (missing permission, deleted message,
 *    platform without reaction support, disallowed emoji) must never affect
 *    message delivery.
 *  - Correlation: processing_ack is keyed by the agent-side message id
 *    (`<platformMsgId>:<agentGroupId>`); we store that next to the platform id
 *    so a status row can be matched back to the message to react on.
 *  - Tracking is in-memory per session and dropped once ✅ lands. A host
 *    restart can orphan a stray reaction (harmless, rare); we accept that over
 *    persisting a table.
 */
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { log } from '../../log.js';

type Stage = 'received' | 'working' | 'done';

interface StageEmoji {
  received: string;
  working: string;
  done: string;
}

/** Per-platform emoji. Telegram bots may only react with a fixed allowed set
 *  (👀 is in it, 🔧/✅ are not), so it gets substitutes from that set. Unknown
 *  platforms default to the Discord set (arbitrary unicode, widely accepted). */
const EMOJI_BY_PLATFORM: Record<string, StageEmoji> = {
  discord: { received: '👀', working: '🔧', done: '✅' },
  telegram: { received: '👀', working: '✍️', done: '👌' },
};
const DEFAULT_EMOJI: StageEmoji = { received: '👀', working: '🔧', done: '✅' };

function emojiFor(channelType: string, stage: Stage): string {
  return (EMOJI_BY_PLATFORM[channelType] ?? DEFAULT_EMOJI)[stage];
}

/** How long a turn must keep running before we show the 🔧 "working" stage.
 *  Turns that finish within this window skip 🔧 and go 👀→✅ directly — most
 *  turns are short, so this avoids 2 reaction API calls per message (Discord
 *  rate-limits reactions hard). 🔧 then only appears on genuinely long turns,
 *  which is exactly when "is it still alive or stuck?" matters. */
const WORKING_REACTION_DELAY_MS = 4000;

/** Safety cap on tracked reactions per session, so the map can't grow unbounded
 *  if a session keeps receiving messages that never reach 'done'. Oldest drop. */
const MAX_PENDING_PER_SESSION = 50;

interface TrackedReaction {
  channelType: string;
  platformId: string;
  threadId: string | null;
  messageId: string; // platform message id — what we react on
  stage: Stage;
  processingSince?: number; // host ms when we first saw this turn 'processing'
}

/** session_id → tracked reactions, keyed by agent-side message id
 *  (`<platformMsgId>:<agentGroupId>`, the processing_ack key). */
const tracked = new Map<string, Map<string, TrackedReaction>>();

/**
 * React to a freshly-routed inbound message to acknowledge receipt (👀) and
 * begin tracking it so later lifecycle stages (working/done) can swap the
 * reaction. Safe to call for every routed user message; a no-op if the channel
 * adapter has no reaction support or the message has no platform id.
 */
export function ackInbound(
  sessionId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  messageId: string | undefined,
  agentMessageId: string,
): void {
  if (!messageId) return;
  const adapter = getChannelAdapter(channelType);
  if (!adapter?.addReaction) return; // platform/adapter has no reaction support

  let perSession = tracked.get(sessionId);
  if (!perSession) {
    perSession = new Map();
    tracked.set(sessionId, perSession);
  }
  perSession.set(agentMessageId, { channelType, platformId, threadId, messageId, stage: 'received' });
  while (perSession.size > MAX_PENDING_PER_SESSION) {
    const oldest = perSession.keys().next().value;
    if (oldest === undefined) break;
    perSession.delete(oldest);
  }

  const emoji = emojiFor(channelType, 'received');
  void adapter.addReaction(platformId, threadId, messageId, emoji).catch((err) => {
    log.warn('progress reaction add failed', { stage: 'received', channelType, platformId, messageId, err });
  });
}

/**
 * Advance reactions for a session from the current processing_ack rows. Called
 * each delivery poll tick (~1s for running sessions).
 *
 * The 🔧 "working" stage is debounced: we only show it once a turn has been
 * processing for WORKING_REACTION_DELAY_MS. A turn that completes before then
 * goes 👀→✅ directly, skipping 🔧 — this keeps the common (short) turn at one
 * reaction swap instead of two, which matters because Discord rate-limits
 * reactions hard. 🔧 therefore only shows on long turns, which is exactly when
 * "still alive or stuck?" is worth signalling. ✅ persists; we drop the
 * tracking record once it lands.
 */
export function syncSessionReactions(sessionId: string, ackRows: Array<{ message_id: string; status: string }>): void {
  const perSession = tracked.get(sessionId);
  if (!perSession || perSession.size === 0) return;
  const now = Date.now();

  for (const row of ackRows) {
    const rec = perSession.get(row.message_id);
    if (!rec) continue;

    if (row.status === 'processing') {
      if (rec.stage !== 'received') continue; // already 'working' or 'done'
      if (rec.processingSince === undefined) rec.processingSince = now;
      // Defer 🔧 until the turn has run long enough to count as "long".
      if (now - rec.processingSince >= WORKING_REACTION_DELAY_MS) swapReaction(rec, 'working');
    } else if (row.status === 'completed' || row.status === 'failed') {
      if (rec.stage === 'done') continue;
      swapReaction(rec, 'done'); // from 'received' (skips 🔧) or 'working'
      perSession.delete(row.message_id);
    }
  }
  if (perSession.size === 0) tracked.delete(sessionId);
}

/** Swap a message's reaction from its current stage to `next`. Remove-then-add
 *  is ordered (awaited inside a detached async) so the old emoji is gone before
 *  the new one lands; the whole thing stays fire-and-forget. */
function swapReaction(rec: TrackedReaction, next: Stage): void {
  const adapter = getChannelAdapter(rec.channelType);
  const oldEmoji = emojiFor(rec.channelType, rec.stage);
  const newEmoji = emojiFor(rec.channelType, next);
  rec.stage = next;
  if (oldEmoji === newEmoji) return; // same glyph on this platform — nothing to do

  void (async () => {
    try {
      if (adapter?.removeReaction) await adapter.removeReaction(rec.platformId, rec.threadId, rec.messageId, oldEmoji);
    } catch (err) {
      log.warn('progress reaction remove failed', { stage: next, ...recMeta(rec), emoji: oldEmoji, err });
    }
    try {
      if (adapter?.addReaction) await adapter.addReaction(rec.platformId, rec.threadId, rec.messageId, newEmoji);
    } catch (err) {
      log.warn('progress reaction add failed', { stage: next, ...recMeta(rec), emoji: newEmoji, err });
    }
  })();
}

function recMeta(rec: TrackedReaction) {
  return { channelType: rec.channelType, platformId: rec.platformId, messageId: rec.messageId };
}
