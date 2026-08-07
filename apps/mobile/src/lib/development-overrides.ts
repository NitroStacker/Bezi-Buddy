export function developmentOverride(
  value: string | undefined,
  isDevelopment = typeof __DEV__ !== "undefined" && __DEV__,
): string | undefined {
  return isDevelopment ? value : undefined;
}
