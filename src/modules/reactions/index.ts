/**
 * Receipt-reaction module (Carbon customization).
 *
 * Adds a 👀 reaction to the user's inbound message the moment the host routes
 * it to an agent ("I saw it, I'm on it"), and removes that reaction as soon as
 * the agent's first reply is delivered back to the same channel. This makes
 * long, tool-heavy turns legible: 👀 present = received / working, 👀 gone =
 * about to answer.
 *
 * Design notes:
 *  - Host-side only. Reactions are a platform operation, so they live where the
 *    channel adapters live (the container can't touch the platform directly).
 *  - Best-effort throughout: every add/remove is fire-and-forget and swallows
 *    its own errors. A reaction failure (missing permission, deleted message,
 *    platform without reaction support) must never affect message delivery.
 *  - Platform-agnostic: dispatches through ChannelAdapter.addReaction /
 *    removeReaction (optional methods). Adapters that don't implement them are
 *    silently skipped.
 *  - Pairing is tracked in-memory per session. A host restart can orphan a
 *    stray 👀 (harmless, rare); we accept that over persisting a table.
 */
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { log } from '../../log.js';

/** The emoji used for the "received / processing" reaction. 👀 is in
 *  Telegram's allowed-reaction set and renders on Discord too. */
const ACK_EMOJI = '👀';

/** Safety cap on tracked reactions per session, in case a session never
 *  produces a reply (so the map can't grow unbounded). Oldest are dropped. */
const MAX_PENDING_PER_SESSION = 50;

interface PendingAck {
  channelType: string;
  platformId: string;
  threadId: string | null;
  messageId: string;
}

/** session_id → reactions we added and haven't cleared yet. */
const pending = new Map<string, PendingAck[]>();

/**
 * React to a freshly-routed inbound message to acknowledge receipt. Safe to
 * call for every routed user message; a no-op if the channel adapter doesn't
 * support reactions or the message has no platform id.
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

  const list = pending.get(sessionId) ?? [];
  list.push({ channelType, platformId, threadId, messageId });
  while (list.length > MAX_PENDING_PER_SESSION) list.shift();
  pending.set(sessionId, list);

  void adapter.addReaction(platformId, threadId, messageId, ACK_EMOJI).catch((err) => {
    log.warn('receipt reaction add failed', { channelType, platformId, messageId, err });
  });
}

/**
 * Clear all receipt reactions tracked for a session. Called when the agent's
 * reply is delivered — 👀 disappears as the answer lands. No-op when nothing
 * is pending.
 */
export function clearAcks(sessionId: string): void {
  const list = pending.get(sessionId);
  if (!list || list.length === 0) return;
  pending.delete(sessionId);

  for (const ack of list) {
    const adapter = getChannelAdapter(ack.channelType);
    if (!adapter?.removeReaction) continue;
    void adapter.removeReaction(ack.platformId, ack.threadId, ack.messageId, ACK_EMOJI).catch((err) => {
      log.warn('receipt reaction remove failed', { ...ack, err });
    });
  }
}
