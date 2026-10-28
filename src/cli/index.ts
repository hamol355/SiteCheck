#!/usr/bin/env node
import { main } from './main.js';

process.exitCode = await main(process.argv, {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  stdoutIsTTY: process.stdout.isTTY === true,
});
