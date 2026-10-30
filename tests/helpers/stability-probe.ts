/**
 * The page-stability probe, for the tests that count the calls a tool makes.
 *
 * After a successful action the action wrapper waits for the page to settle:
 * it reads the page's text inside the page until it stops changing. That read
 * is a call to browser_evaluate like any other, so it shows up in a test host's
 * call list. It is an implementation detail of the wait, not something the
 * agent asked for, so the tests that count calls filter it out.
 *
 * Its expression is the only one that reads innerText, so that is what tells
 * the probe apart from a browser_evaluate the agent asked for.
 */
export interface RecordedCall {
  tool: string;
  params: Record<string, unknown>;
}

export function isStabilityProbe(call: RecordedCall): boolean {
  const expression = call.params?.expression;
  return call.tool === 'browser_evaluate'
    && typeof expression === 'string'
    && expression.includes('innerText');
}

/** The recorded calls without the stability probe. */
export function withoutStabilityProbe(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => !isStabilityProbe(call));
}
