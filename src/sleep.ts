/** setTimeout-based sleep — works on both Node and Bun. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))
