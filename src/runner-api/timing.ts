/**
 * Waits for `work` for at most `ms`. Resolves `true` if it settled in time,
 * `false` if the time ran out (the work itself keeps running).
 */
export async function settlesWithin(
  work: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}
