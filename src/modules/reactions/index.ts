/**
 * Progress-reaction module (Carbon customization).
 *
 * A reaction on the user's own inbound message that tracks the reply lifecycle,
 * so a long turn is legible at a glance:
 *
 *   👀 received — the host routed the message (set in the router).
 *   🔧 working  — no reply yet after WORKING_REACTION_DELAY_MS, i.e. the turn is
 *                 taking a while (a long task — or stuck).
 *   ✅ done     — a reply was actually delivered to the channel for this session.
 *
 * Signals are deliberately host-side and reliable: routing (👀), a timer (🔧),
 * and real outbound delivery (✅). An earlier version drove these off the
 * container's `processing_ack` table, but that is batch-oriented — a follow-up
 * message pushed into an already-open agent query is marked completed the
 * instant it is pushed (poll-loop `markCompleted` right after `query.push`),
 * not when its work finishes — so a 20s task flipped to ✅ within a second.
 * Actual delivery is the only signal that reliably means "the agent answered".
 *
 * Stages swap in place (one reaction at a time). A turn that never delivers a
 * reply stays at 👀→🔧 and never reaches ✅ — which is exactly the "is it stuck
 * or crashed?" signal. ✅ persists; the tracking record is dropped once it lands.
 *
 * Platform emoji sets differ: Telegram bots may only react with a fixed allowed
 * set (👀 is in it, 🔧/✅ are not), so Telegram uses ✍️/👌 substitutes.
 *
 * Best-effort throughout: every add/remove is fire-and-forget and swallows its
 * own errors — a reaction failure must never affect message delivery.
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

/** How long a turn may run with no reply before we show 🔧. Short turns deliver
 *  before this and go 👀→✅, skipping 🔧 — which also keeps Discord reaction API
 *  calls low (it rate-limits reactions hard). 🔧 then only shows on long turns,
 *  exactly when "still alive or stuck?" is worth signalling. */
const WORKING_REACTION_DELAY_MS = 4000;

/** Safety cap on tracked reactions per session, so the list can't grow unbounded
 *  if a session keeps receiving messages that never get a reply. Oldest drop. */
const MAX_PENDING_PER_SESSION = 50;

interface TrackedReaction {
  channelType: string;
  platformId: string;
  threadId: string | null;
  messageId: string; // platform message id — what we react on
  stage: Stage;
  receivedAt: number; // host ms when the message was routed
}

/** session_id → reactions we're tracking (in arrival order). */
const tracked = new Map<string, TrackedReaction[]>();

/**
 * React 👀 to a freshly-routed inbound message and begin tracking it so the
 * reaction can advance to 🔧 / ✅ later. Safe to call for every routed user
 * message; a no-op if the adapter has no reaction support or the message has no
 * platform id.
 */
export function ackInbound(
  sessionId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  messageId: string | undefined,
): void {
  if (!messageId) return;
  const adapter = getChannelAdapter(channelType);
  if (!adapter?.addReaction) return; // platform/adapter has no reaction support

  const list = tracked.get(sessionId) ?? [];
  list.push({ channelType, platformId, threadId, messageId, stage: 'received', receivedAt: Date.now() });
  while (list.length > MAX_PENDING_PER_SESSION) list.shift();
  tracked.set(sessionId, list);

  const emoji = emojiFor(channelType, 'received');
  void adapter.addReaction(platformId, threadId, messageId, emoji).catch((err) => {
    log.warn('progress reaction add failed', { stage: 'received', channelType, platformId, messageId, err });
  });
}

/**
 * Advance any reaction still at 👀 'received' (no reply yet) past the delay to
 * 🔧 'working'. Called each delivery poll tick (~1s for running sessions), so 🔧
 * appears ~WORKING_REACTION_DELAY_MS after a still-unanswered message.
 */
export function advanceWorkingReactions(sessionId: string): void {
  const list = tracked.get(sessionId);
  if (!list || list.length === 0) return;
  const now = Date.now();
  for (const rec of list) {
    if (rec.stage === 'received' && now - rec.receivedAt >= WORKING_REACTION_DELAY_MS) {
      swapReaction(rec, 'working');
    }
  }
}

/**
 * A reply was delivered to the channel for this session — swap every
 * outstanding reaction to ✅ 'done' and drop tracking (✅ persists on the
 * platform). Replaces the old "remove the 👀 on reply" behaviour.
 */
export function markSessionReplied(sessionId: string): void {
  const list = tracked.get(sessionId);
  if (!list || list.length === 0) return;
  tracked.delete(sessionId);
  for (const rec of list) {
    if (rec.stage !== 'done') swapReaction(rec, 'done');
  }
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
