import { Terminal } from "../terminal.ts";

const terminal = new Terminal({
  write: (data) => process.stdout.write(`write:${JSON.stringify(data)}\n`),
  columns: 80,
  rows: 24,
  isTty: true,
  setRawMode: (raw) => process.stdout.write(`raw:${raw}\n`),
});
terminal.onExit = (signal) => process.stdout.write(`signal:${signal}\n`);

terminal.start();
process.stdout.write("ready\n");

if (process.argv[2] === "signal") {
  setInterval(() => {}, 1_000);
} else {
  setTimeout(() => {
    throw new Error("terminal safety fixture crash");
  }, 10);
}
