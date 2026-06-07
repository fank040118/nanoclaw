/**
 * Progress-reaction module (Carbon customization).
 *
 * A reaction on the user's own inbound message that tracks the reply lifecycle,
 * so a long turn is legible at a glance:
 *
 *   👀 received — the host routed the message (set in the router).
 *   🔧 working  — no completion yet after WORKING_REACTION_DELAY_MS, i.e. the
 *                 turn is taking a while (a long task — or stuck).
 *   ✅ done     — the agent's turn finished, whether or not it produced a reply.
 *
 * ✅ is driven by a turn-completion counter the container bumps on every
 * `result` event (session_state `turns_completed`), NOT by reply delivery. So a
 * turn that completes WITHOUT replying still reaches ✅ — making "✅ but no reply
 * in the channel" mean "the reply failed/was dropped", while "🔧 that never
 * becomes ✅" means "crashed mid-turn before finishing". Reply delivery is also
 * wired as a ✅ trigger (immediate when the reply lands); whichever fires first
 * wins.
 *
 * An earlier version used the container's `processing_ack` table, but that is
 * batch-oriented — a follow-up message pushed into an open agent query is marked
 * completed the instant it is pushed, not when its work finishes — so it flipped
 * a 20s task to ✅ within a second. The `turns_completed` counter is bumped only
 * at the real `result` event, so it is reliable for every turn.
 *
 * Stages swap in place (one reaction at a time). ✅ persists; the tracking
 * record is dropped once it lands. Each tracked message captures its own
 * turns-completed baseline on first observation (not at receipt — the host's
 * in-memory state is empty after a restart), so it only reaches ✅ on a turn
 * that completes AFTER it arrived.
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
  reactThreadId: string | null; // thread/channel to react IN (see resolveReactTarget)
  messageId: string; // platform message id — what we react on
  stage: Stage;
  receivedAt: number; // host ms when the message was routed
  turnsBaseline?: number; // session turns_completed at first observation; ✅ when it grows
}

/** session_id → reactions we're tracking (in arrival order). */
const tracked = new Map<string, TrackedReaction[]>();

/**
 * Decide which thread/channel to *react in* for a message.
 *
 * A reaction must target the channel the message physically lives in. On
 * Discord, when a conversation runs in a thread, the thread id is the id of its
 * root message — so the inbound threadId looks like `…:<channel>:<rootMsgId>`.
 * The root message itself lives in the PARENT channel, not inside the thread,
 * so reacting to it via the thread id 404s ("Unknown Message"). Messages posted
 * *inside* the thread are found via the thread id as normal.
 *
 * So: if threadId ends with `:<messageId>`, this message is the thread root —
 * react in the parent channel (platformId, which carries no thread suffix).
 * Otherwise react in the thread (threadId). Returning null makes the adapter
 * fall back to platformId.
 */
function resolveReactTarget(platformId: string, threadId: string | null, messageId: string): string | null {
  if (threadId && threadId.endsWith(`:${messageId}`)) return null; // thread root → parent channel
  return threadId;
}

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

  const reactThreadId = resolveReactTarget(platformId, threadId, messageId);
  const list = tracked.get(sessionId) ?? [];
  list.push({ channelType, platformId, reactThreadId, messageId, stage: 'received', receivedAt: Date.now() });
  while (list.length > MAX_PENDING_PER_SESSION) list.shift();
  tracked.set(sessionId, list);

  const emoji = emojiFor(channelType, 'received');
  void withReactionRetry(() => adapter.addReaction!(platformId, reactThreadId, messageId, emoji)).catch((err) => {
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

/**
 * Advance reactions to ✅ for messages whose turn has completed, based on the
 * container's monotonic `turns_completed` counter. Called each delivery poll
 * tick with the current counter value. Each tracked message captures its
 * baseline on first observation; once the counter grows beyond that baseline a
 * turn has finished since the message arrived, so it reaches ✅ — even if no
 * reply was delivered. (Reply delivery, via markSessionReplied, also drives ✅;
 * whichever fires first wins.)
 */
export function syncTurnCompletion(sessionId: string, turnsCompleted: number): void {
  const list = tracked.get(sessionId);
  if (!list || list.length === 0) return;
  const remaining: TrackedReaction[] = [];
  for (const rec of list) {
    if (rec.turnsBaseline === undefined) {
      // First time we see this message against the counter — record the baseline
      // (the host's in-memory state is empty after a restart, so we can't trust
      // anything captured at receipt). Don't mark done yet.
      rec.turnsBaseline = turnsCompleted;
      remaining.push(rec);
    } else if (rec.stage !== 'done' && turnsCompleted > rec.turnsBaseline) {
      swapReaction(rec, 'done');
    } else {
      remaining.push(rec);
    }
  }
  if (remaining.length === 0) tracked.delete(sessionId);
  else tracked.set(sessionId, remaining);
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
      if (adapter?.removeReaction)
        await withReactionRetry(() =>
          adapter.removeReaction!(rec.platformId, rec.reactThreadId, rec.messageId, oldEmoji),
        );
    } catch (err) {
      log.warn('progress reaction remove failed', { stage: next, ...recMeta(rec), emoji: oldEmoji, err });
    }
    try {
      if (adapter?.addReaction)
        await withReactionRetry(() => adapter.addReaction!(rec.platformId, rec.reactThreadId, rec.messageId, newEmoji));
    } catch (err) {
      log.warn('progress reaction add failed', { stage: next, ...recMeta(rec), emoji: newEmoji, err });
    }
  })();
}

function recMeta(rec: TrackedReaction) {
  return { channelType: rec.channelType, platformId: rec.platformId, messageId: rec.messageId };
}

/**
 * Run a reaction API call, retrying on Discord 429 rate limits (the reaction
 * endpoints are throttled hard, and the 3-stage flow makes several calls in
 * quick succession). Honors the `retry_after` from the error body; gives up
 * after a few attempts so a persistent failure can't loop. Re-throws the last
 * error so the caller's `.catch` can log it.
 */
async function withReactionRetry(fn: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fn();
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('429') || attempt >= 2) throw err;
      const m = msg.match(/retry_after"?\s*:\s*([\d.]+)/);
      const waitMs = (m ? Math.ceil(parseFloat(m[1]) * 1000) : 400) + 150;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
