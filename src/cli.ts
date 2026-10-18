#!/usr/bin/env node
import { processIo } from "./shell/io";
import { runCli } from "./shell/run";

process.exitCode = await runCli(process.argv.slice(2), processIo());
