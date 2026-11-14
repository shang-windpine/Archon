/**
 * devflow-refine's pure decisions: when the round gate asks a person, what the previous
 * round's gate answer means for this round, and the markdown the refine log and the
 * finalized requirement receive. Nothing here reads the environment or the filesystem.
 */

export const REFINE_HUMAN_MODES = ['auto', 'always', 'never'] as const;
export type RefineHumanMode = (typeof REFINE_HUMAN_MODES)[number];

export type ReviewVerdict = 'approve' | 'revise';

/** The round gate's options; the YAML declares the same ids and the gate output carries one. */
export const GATE_DECISIONS = ['finalize', 'revise'] as const;
export type GateDecision = (typeof GATE_DECISIONS)[number];

/**
 * Whether this round's gate asks a person (DESIGN §5). `always` asks every round;
 * `auto` asks when the reviewer needs a person or approves; `never` asks only on approve,
 * because finalizing always takes a person's choice.
 */
export function gateAsks(
  mode: RefineHumanMode,
  verdict: ReviewVerdict,
  needsHuman: boolean
): boolean {
  switch (mode) {
    case 'always':
      return true;
    case 'auto':
      return needsHuman || verdict === 'approve';
    case 'never':
      return verdict === 'approve';
    default: {
      const unhandled: never = mode;
      return unhandled;
    }
  }
}

/** What the gate recommends: finalize an approved draft that needs no person, else revise. */
export function gateRecommendation(
  verdict: ReviewVerdict,
  needsHuman: boolean
): { option: GateDecision; why: string; confidence: 'low' | 'medium' | 'high' } {
  if (verdict === 'approve' && !needsHuman) {
    return {
      option: 'finalize',
      why: 'The reviewer approved the draft and raised nothing for a person.',
      confidence: 'medium',
    };
  }
  if (verdict === 'approve') {
    return {
      option: 'revise',
      why: 'The reviewer approved but needs your answers to the questions first.',
      confidence: 'medium',
    };
  }
  return { option: 'revise', why: 'The reviewer asked for changes.', confidence: 'medium' };
}

/** The previous round's gate answer as `$LOOP_PREV` delivers it: `''` when there was none. */
export type PreviousAnswer = { readonly decision: string; readonly text: string };

export type ControlStep =
  | { readonly kind: 'first' }
  | { readonly kind: 'continue' }
  | { readonly kind: 'revise'; readonly text: string }
  | { readonly kind: 'finalize'; readonly text: string };

/**
 * Read the previous round's gate answer. An empty decision means the gate did not run
 * (round 1, or a round whose gate `when:` skipped it). Any other value than the declared
 * options throws: the gate's options and this reader must agree, and a mismatch must not
 * silently loop or finalize.
 */
export function controlStep(round: number, previous: PreviousAnswer): ControlStep {
  const decision = previous.decision.trim();
  const text = previous.text.trim();
  if (decision === '') return round === 1 ? { kind: 'first' } : { kind: 'continue' };
  if (decision === 'finalize') return { kind: 'finalize', text };
  if (decision === 'revise') return { kind: 'revise', text };
  throw new Error(
    `the previous round's gate answered ${JSON.stringify(decision)}, which is not one of ${GATE_DECISIONS.join(', ')}`
  );
}

/** A fenced block that the text cannot close early, whatever backtick runs it contains. */
export function fenced(text: string, info = ''): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const body = text.endsWith('\n') ? text : `${text}\n`;
  return `${fence}${info}\n${body}${fence}\n`;
}

/** The refine log's heading for one run; every later entry of the run sits under it. */
export function runHeading(runId: string, at: string): string {
  return `\n## devflow-refine run ${runId} (${at})\n`;
}

/** The refine log's entry for a person's gate answer. */
export function humanEntry(round: number, decision: GateDecision, text: string): string {
  const body = text === '' ? '_(no text)_\n' : fenced(text, 'text');
  return `\n### Round ${round} — human answer: ${decision}\n\n${body}`;
}

export interface ReviewRecord {
  readonly round: number;
  readonly verdict: ReviewVerdict;
  readonly needsHuman: boolean;
  readonly asked: boolean;
  readonly summary: string;
  readonly questions: readonly string[];
  readonly review: string;
}

/** The refine log's entry for one round's review; the review file is fenced so its headings cannot break the log's structure. */
export function reviewEntry(record: ReviewRecord): string {
  const asked = record.asked ? 'a person is asked' : 'no person is asked';
  return [
    `\n### Round ${record.round} — review: ${record.verdict}, needs_human ${String(record.needsHuman)} (${asked})\n`,
    `\n${record.summary.trim()}\n`,
    record.questions.length > 0 ? `\nQuestions for a person:\n\n${numbered(record.questions)}` : '',
    `\n${fenced(record.review, 'markdown')}`,
  ].join('');
}

/** Questions as a numbered list, or `(none)`. */
export function numbered(questions: readonly string[]): string {
  if (questions.length === 0) return '(none)\n';
  return `${questions.map((question, index) => `${String(index + 1)}. ${question.trim()}`).join('\n')}\n`;
}

/**
 * The decision-log lines finalize appends to the requirement for notes a person gave when
 * finalizing. The requirement template keeps the decision log as the last section, so the
 * lines land in it. A note is recorded verbatim on one line; the sections above it were not
 * redrafted to reflect it, and the line says so.
 */
export function finalizationLines(
  date: string,
  runId: string,
  notes: readonly { readonly source: string; readonly text: string }[]
): string {
  const lines = notes
    .map(note => ({ source: note.source, text: note.text.replace(/\s+/g, ' ').trim() }))
    .filter(note => note.text !== '')
    .map(
      note =>
        `- ${date} — Operator note at finalization: ${JSON.stringify(note.text)} — operator (${note.source}, run ${runId}) — recorded verbatim; the sections above were not redrafted to reflect it.`
    );
  return lines.length === 0 ? '' : `\n${lines.join('\n')}\n`;
}
