/**
 * The user stopped an uploader, with Ctrl-C or an MCP cancel. The uploader
 * turns it into the error of the phase it stopped in.
 */
export class Interrupted extends Error {
  constructor() {
    super("Interrupted");
    this.name = "Interrupted";
  }
}
