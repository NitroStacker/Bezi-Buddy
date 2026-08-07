export const THREAD_FOLLOW_SCROLL_EPSILON = 8;
export const THREAD_FOLLOW_END_EPSILON = 8;

export function threadDistanceFromEnd(
  contentHeight: number,
  viewportHeight: number,
  offsetY: number,
) {
  return Math.max(0, contentHeight - viewportHeight - offsetY);
}

export function shouldPauseThreadFollow(
  dragStartOffsetY: number,
  currentOffsetY: number,
) {
  return dragStartOffsetY - currentOffsetY > THREAD_FOLLOW_SCROLL_EPSILON;
}

export function isThreadAtEnd(distanceFromEnd: number) {
  return distanceFromEnd <= THREAD_FOLLOW_END_EPSILON;
}
