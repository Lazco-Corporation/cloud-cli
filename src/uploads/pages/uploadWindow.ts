import { CliError } from "../../core/errors";
import type { Clock } from "../../core/request/clock";

/** How long before the window ends the uploader renews it: time for a failed renewal to be tried again. */
export const RENEW_BEFORE_MS = 10 * 60 * 1000;

/**
 * The upload window of a deployment, in the server's time. The end comes
 * from `uploadExpiresAt` and the `Date` header of the same answer, so a local
 * clock that is minutes wrong moves nothing: only the time elapsed on it counts.
 */
export class UploadWindow {
  private readonly clock: Clock;
  private endsAt = 0;
  /** The server's time minus the local time, when the last answer came. */
  private offset = 0;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  /** Sets the end from an answer's `uploadExpiresAt` and its `Date` header. */
  update(uploadExpiresAt: unknown, dateHeader: string | null): void {
    const end = typeof uploadExpiresAt === "string" ? Date.parse(uploadExpiresAt) : Number.NaN;
    if (Number.isNaN(end)) {
      throw new CliError("CLI_BAD_RESPONSE", "The deployment has no valid uploadExpiresAt", {
        uploadExpiresAt,
      });
    }
    const serverNow = dateHeader === null ? Number.NaN : Date.parse(dateHeader);
    this.offset = Number.isNaN(serverNow) ? 0 : serverNow - this.clock.now();
    this.endsAt = end;
  }

  /** The time left in the window, by the server's clock. */
  remainingMs(): number {
    return this.endsAt - (this.clock.now() + this.offset);
  }

  needsRenewal(): boolean {
    return this.remainingMs() < RENEW_BEFORE_MS;
  }
}
