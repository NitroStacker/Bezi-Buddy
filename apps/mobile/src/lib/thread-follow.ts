export const THREAD_FOLLOW_IDLE_MS = 15_000;

export function threadFollowResumeDelay(
  lastInteractionAt: number,
  now: number,
) {
  const elapsed = Math.max(0, now - lastInteractionAt);
  return Math.max(0, THREAD_FOLLOW_IDLE_MS - elapsed);
}
