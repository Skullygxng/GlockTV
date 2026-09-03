/*
 * Types for the check definitions.
 *
 * The checks themselves stay plain .mjs so the verifier runs under node with no
 * build step - it has to work in a workflow that has not compiled anything.
 * This declares the shape so the fixture tests are type-checked rather than
 * silently any, which is where a test that asserts nothing would hide.
 */

export interface CheckOutcome {
  ok: boolean;
  detail: string;
}

export interface PermissionCheck {
  id: string;
  name: string;
  run: () => Promise<CheckOutcome>;
}

export interface Caller {
  label: string;
  apikey: string;
  accessToken: string;
}

export type RestResult = { response: { status: number }; body: string };
export type Rest = (
  who: Caller,
  method: string,
  path: string,
  payload?: unknown,
  extraHeaders?: Record<string, string>,
) => Promise<RestResult>;

export function caller(label: string, apikey: string, accessToken?: string): Caller;
export function OK(detail?: string): CheckOutcome;
export function BAD(detail: string): CheckOutcome;
export function refused(response: { status: number }): boolean;
export function readBlocked(response: { status: number }, body: string): boolean;

export function billingChecks(input: {
  rpc: (who: Caller, payload: unknown) => Promise<RestResult>;
  payloadFor: () => unknown;
  service: Caller;
  anon: Caller;
  user: Caller;
}): PermissionCheck[];

export function watchProgressChecks(input: {
  rest: Rest;
  userA: Caller;
  userB: Caller;
  anonymous: Caller | null;
  progressRow: (input: { mediaId: number; forUser?: string }) => Record<string, unknown>;
}): PermissionCheck[];

export function supportChecks(input: {
  rest: Rest;
  userA: Caller;
  userB: Caller;
  staff: Caller | null;
  state: Record<string, string>;
}): PermissionCheck[];
